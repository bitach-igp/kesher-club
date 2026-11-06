// The API as a process (T-0021). Config first, so a missing value exits before anything opens; then
// the Postgres pool, the PII cipher, the identity repository, the provider registry and createApp,
// then listen. SIGTERM stops accepting, lets in-flight requests finish (up to DRAIN_MS) and closes
// the pool. Lifecycle lines go to stdout as JSON and carry no request data, member data or config
// values (constitution art. 9, AGENTS.md).
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@kesher/domain';
import type { JWK } from 'jose';
import { createApp } from './app.ts';
import { PostgresIdentityRepository } from './auth/pg-repository.ts';
import { importSigningKey } from './auth/tokens.ts';
import { loadApiConfig, type ApiConfig } from './config.ts';
import { createPiiCipher } from './crypto/pii.ts';
import { createPgDatabase } from './pg.ts';
import { createRegistry, crowdedWebhookSecrets, overridesFromConfig } from './registry.ts';
import { createServer } from './server.ts';

/** How long SIGTERM waits for in-flight requests; ECS gives 30 s before SIGKILL, so this leaves room. */
export const DRAIN_MS = 10_000;

export interface RunningApi {
  /** The port actually bound. */
  port: number;
  /** Stops accepting, drains in-flight requests (cut after `DRAIN_MS`), closes the pool. Idempotent. */
  shutdown(): Promise<void>;
}

/** The process logger before the config is known (boot failures, signals); once it is, `main` logs with its market. */
export const log = createLogger({ service: 'api' });

export async function main(env: Record<string, string | undefined>): Promise<RunningApi> {
  const config: ApiConfig = loadApiConfig(env); // throws ConfigError, naming every problem, before anything opens
  const logger = createLogger({ service: 'api', market: config.MARKET });
  const db = createPgDatabase(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  try {
    const pii = createPiiCipher({ dataKey: config.PII_DATA_KEY, indexKey: config.PII_INDEX_KEY });
    const signingKey = await importSigningKey(JSON.parse(config.JWT_SIGNING_KEY.reveal()) as JWK, config.JWT_SIGNING_KID);
    // The banking port's provider is chosen by config (T-0659); its idempotency keys live in Postgres so a restart loses none.
    const { registry, providers } = createRegistry(config.PROVIDER_MODE_DEFAULT, undefined, overridesFromConfig(config, db, (message) => logger('warning', { message })));
    const app = createApp({
      db,
      registry,
      market: config.MARKET,
      signingKey,
      issuer: config.TOKEN_ISSUER,
      identity: new PostgresIdentityRepository(db, pii),
      pii,
      staffJwks: config.STAFF_JWKS,
      // The receiver at /webhooks/crowded verifies with these; with none (the simulator) it refuses every delivery.
      crowdedWebhookSecrets: crowdedWebhookSecrets(config),
      ...(config.MEMBER_APP_URL ? { oauth: { consentUrl: `${config.MEMBER_APP_URL.replace(/\/$/, '')}/connect` } } : {}),
    });
    const server = createServer(app, { role: config.SERVICE_ROLE, log: logger });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.PORT, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    logger('listening', { port, role: config.SERVICE_ROLE, mode: config.PROVIDER_MODE_DEFAULT, providers });
    let closing: Promise<void> | undefined;
    return {
      port,
      shutdown: () =>
        (closing ??= (async () => {
          logger('draining', { drainMs: DRAIN_MS });
          await drain(server, DRAIN_MS);
          await db.close();
          logger('stopped');
        })()),
    };
  } catch (e) {
    await db.close();
    throw e;
  }
}

/**
 * Stops accepting connections and resolves once every in-flight request has finished. Idle keep-alive
 * sockets close at once; a request still running after `ms` has its connection cut so shutdown always ends.
 */
export async function drain(server: http.Server, ms: number): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  if ((await Promise.race([closed, deadline])) === 'timeout') {
    server.closeAllConnections();
    await closed;
  }
  clearTimeout(timer);
}

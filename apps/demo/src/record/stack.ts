// The recording stack (T-0920): the T-0031 process on a fresh in-memory database, seeded with the T-0032
// personas and the T-0034 yeshiva, its club rate fetched, then a readiness port the recorder waits on, which
// also answers a member's processor card id for the JIT hook.
// Development only, like `pnpm dev`: APP_ENV must be development, and every key comes from the recorder.
//
//   node --experimental-strip-types src/record/stack.ts   (started by playwright.config.ts, not by hand)
import http from 'node:http';
import type { JWK } from 'jose';
import { loadConfig } from '@kesher/domain';
import { createTestDatabase } from '@kesher/api/test-db';
import { z } from 'zod';
import { log, startDev } from '../dev.ts';
import { formatTable, seed } from '../seed.ts';

const config = loadConfig(
  z.object({
    APP_ENV: z.literal('development'),
    STAFF_JWKS: z.string().min(1),
    ADMIN_API_SIGNING_KEY: z.string().min(1),
    ADMIN_API_SIGNING_KID: z.string().min(1),
    RECORD_READY_PORT: z.coerce.number().int().positive(),
  }),
  process.env,
);

const db = await createTestDatabase();
const dev = await startDev({ ...process.env, DATABASE_URL: 'postgres://record@localhost/in-memory' }, { db });
await dev.runJob('fx-refresh-rates');
const result = await seed({ apiUrl: `http://127.0.0.1:${dev.apiPort}`, panelUrl: `http://127.0.0.1:${dev.panelPort}`, staffKey: { jwk: JSON.parse(config.ADMIN_API_SIGNING_KEY) as JWK, kid: config.ADMIN_API_SIGNING_KID } });
process.stdout.write(`${formatTable(result)}\n`);
// Readiness, and the one thing the recorder cannot ask the product: the processor's id for a member's card,
// which the panel's JIT hook needs to tap it at a till. Members and staff never see processor ids.
http
  .createServer((req, res) => {
    const party = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cardOf');
    if (!party) return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ready');
    void db.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1 and status = 'active' order by issued_at limit 1`, [party]).then((r) => {
      const id = r.rows[0]?.processor_card_id;
      res.writeHead(id ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(id ? { processorCardId: id } : { error: 'no_active_card' }));
    });
  })
  .listen(config.RECORD_READY_PORT, () => log('record_ready', { port: config.RECORD_READY_PORT }));

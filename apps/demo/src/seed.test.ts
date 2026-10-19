// T-0032: the seed makes every persona through the running demo stack's API and panel, and is idempotent:
// a second run against the same database writes no transfer and no journal, prints the same table, and
// every persona can still sign in with its seeded passkey.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import type { PasskeyAuthenticationOptions } from '@kesher/ports';
import { createClient } from '@kesher/sdk';
import { startDev, type RunningDev } from './dev.ts';
import { deviceIdOf, passkeyOf, PERSONAS } from './personas.ts';
import { formatTable, seed, type SeededPersona, type SeedTarget } from './seed.ts';

let db: TestDatabase;
let dev: RunningDev;
let target: SeedTarget;

const count = async (table: string): Promise<number> => ((await db.query(`select count(*)::int as n from ${table}`)).rows[0] as { n: number }).n;
const byKey = (rows: readonly SeededPersona[], key: string): SeededPersona => rows.find((r) => r.persona.key === key)!;

beforeAll(async () => {
  db = await createTestDatabase();
  dev = await startDev({ APP_ENV: 'development', DATABASE_URL: 'postgres://demo@localhost/unused' }, { db, schedule: false, ports: { api: 0, panel: 0 } });
  target = { apiUrl: `http://127.0.0.1:${dev.apiPort}`, panelUrl: `http://127.0.0.1:${dev.panelPort}` };
}, 60_000);
afterAll(async () => {
  await dev?.shutdown();
  await db?.close();
});

describe('demo seed (T-0032)', () => {
  it('makes every persona through the API, and a second run makes nothing new and prints the same table', async () => {
    const first = await seed(target);
    const transfers = await count('ops.transfer');
    const journals = await count('ledger.journal');
    const loads = PERSONAS.reduce((n, p) => n + p.loads.length, 0);
    expect(transfers).toBe(loads);

    expect(byKey(first, 'dana')).toMatchObject({ kyc: 'T2', usd: 50_000n, ils: 0n, card: 'active' });
    expect(byKey(first, 'noa')).toMatchObject({ kyc: 'T2', usd: 10_000n, ils: 500_000n });
    expect(byKey(first, 'maya')).toMatchObject({ kyc: 'T1', ils: 100_000n, card: 'none' });
    expect(byKey(first, 'eli')).toMatchObject({ kyc: 'T1', usd: 0n, ils: 0n });
    expect(byKey(first, 'tamar')).toMatchObject({ kyc: 'T2', usd: 20_000n, card: 'active' });
    expect(byKey(first, 'ruth')).toMatchObject({ kyc: 'T1', usd: 3_000n, ils: 0n, card: 'none' });
    expect(new Set(first.map((r) => r.partyId)).size).toBe(PERSONAS.length);

    const second = await seed(target);
    expect(await count('ops.transfer')).toBe(transfers);
    expect(await count('ledger.journal')).toBe(journals);
    expect(formatTable(second)).toBe(formatTable(first));
  }, 120_000);

  it('each persona signs in with its seeded passkey as the party the seed made', async () => {
    const rows = await seed(target);
    const anon = createClient({ baseUrl: target.apiUrl });
    for (const p of PERSONAS) {
      const deviceId = deviceIdOf(p);
      const { options } = await anon.post('/auth/passkeys/authenticate', { body: { deviceId } });
      const response = passkeyOf(p).authenticate(options as unknown as PasskeyAuthenticationOptions) as unknown as Record<string, never>;
      const { tokens } = await anon.post('/auth/passkeys/authenticate', { body: { deviceId, response } });
      const principal = await dev.app.services.tokens.verifyAccess(tokens!.accessToken);
      expect(principal.partyId).toBe(byKey(rows, p.key).partyId);
    }
  }, 60_000);

  it('prints no token and lists the personas the contract cannot make yet', async () => {
    const table = formatTable(await seed(target));
    expect(table).not.toMatch(/eyJ|rt_|su_|otps_/);
    expect(table).toContain('Not seeded');
    expect(table).toContain('REC-14');
  }, 60_000);
});

// T-0032: the seed makes every persona through the running demo stack's API and panel, and is idempotent:
// a second run against the same database writes no transfer and no journal, prints the same table, and
// every persona can still sign in with its seeded passkey. T-0034: with the console's staff key it also
// onboards the yeshiva through /admin/*, grants both finance personas with two admins, and imports the
// roster; a rerun makes no second institution, grant or import. T-0625: its KYB checks run against the
// KybPort simulator, and its own bank account is recorded by one compliance member and approved by another.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import type { PasskeyAuthenticationOptions } from '@kesher/ports';
import { createClient } from '@kesher/sdk';
import { startDev, type RunningDev } from './dev.ts';
import { deviceIdOf, INSTITUTION, passkeyOf, PERSONAS } from './personas.ts';
import { formatTable, seed, type SeededPersona, type SeedTarget } from './seed.ts';

let db: TestDatabase;
let dev: RunningDev;
let target: SeedTarget;

const count = async (table: string): Promise<number> => ((await db.query(`select count(*)::int as n from ${table}`)).rows[0] as { n: number }).n;
const byKey = (rows: readonly SeededPersona[], key: string): SeededPersona => rows.find((r) => r.persona.key === key)!;

beforeAll(async () => {
  db = await createTestDatabase();
  // The pair .env.local-staff holds: the API trusts the public half, the seed signs with the private one.
  const pair = await generateKeyPair('ES256', { extractable: true });
  const staffJwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'local-staff-1', alg: 'ES256', use: 'sig' }] });
  dev = await startDev({ APP_ENV: 'development', DATABASE_URL: 'postgres://demo@localhost/unused', STAFF_JWKS: staffJwks }, { db, schedule: false, ports: { api: 0, panel: 0 } });
  target = { apiUrl: `http://127.0.0.1:${dev.apiPort}`, panelUrl: `http://127.0.0.1:${dev.panelPort}`, staffKey: { jwk: (await exportJWK(pair.privateKey)) as JWK, kid: 'local-staff-1' } };
}, 60_000);
afterAll(async () => {
  await dev?.shutdown();
  await db?.close();
});

describe('demo seed (T-0032)', () => {
  it('makes every persona through the API, and a second run makes nothing new and prints the same table', async () => {
    const first = (await seed(target)).personas;
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
    expect(formatTable(second)).toBe(formatTable({ personas: first, institution: second.institution }));
  }, 120_000);

  it('each persona signs in with its seeded passkey as the party the seed made', async () => {
    const rows = (await seed(target)).personas;
    const anon = createClient({ baseUrl: target.apiUrl });
    for (const p of PERSONAS) {
      const deviceId = deviceIdOf(p);
      const { options } = await anon.post('/auth/passkeys/authenticate', { body: { deviceId } });
      const response = (await (await passkeyOf(p)).authenticate(options as unknown as PasskeyAuthenticationOptions)) as unknown as Record<string, never>;
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

describe('demo yeshiva (T-0034)', () => {
  it('onboards the yeshiva once, with both finance personas granted by two admins and the roster imported', async () => {
    const { personas, institution } = await seed(target);
    expect(institution).toMatchObject({ name: INSTITUTION.name, finance: ['rivka', 'shimon'], rosterStatus: 'committed', rosterRows: 3 });
    expect(await count('org.institution')).toBe(1);
    expect(await count('org.roster_import')).toBe(1);
    expect(await count("ops.approval_request where kind = 'staff_grant' and status = 'approved'")).toBe(2);
    expect(await count('org.member')).toBe(3);
    const rivka = byKey(personas, 'rivka').partyId;
    expect((await dev.app.services.identity.findUser(rivka))!.roles).toEqual(['member', 'org_finance']);
    const grants = await dev.app.services.audit.list(rivka, 10);
    expect(grants.find((e) => e.action === 'institution.staff.grant')!.payload).toMatchObject({ role: 'finance', institutionId: institution!.id });
    // Its KYB is approved (T-0621), with Rivka at T2 as its control person, so its money flows are open.
    expect(byKey(personas, 'rivka').kyc).toBe('T2');
    expect(await dev.app.services.institutionKyb.current(institution!.id)).toMatchObject({ status: 'approved', risk: 'low' });
    expect((await dev.app.services.institutionKyb.record(institution!.id)).people).toEqual([expect.objectContaining({ partyId: rivka, roles: ['control', 'signatory'] })]);
    // Its checks came from the KybPort simulator, and its own bank account is active (T-0625), so it can withdraw.
    expect((await dev.app.services.institutionKyb.record(institution!.id)).checks.find((c) => c.kind === 'identifier')).toMatchObject({ provider: 'simulator', result: 'clear', detail: { registeredName: INSTITUTION.name } });
    expect(await dev.app.services.payoutAccounts.active(institution!.id)).toEqual({ iban: INSTITUTION.payoutIban, holderName: INSTITUTION.name });

    await seed(target);
    expect(await count('org.institution')).toBe(1);
    expect(await count('org.roster_import')).toBe(1);
    expect(await count("ops.approval_request where kind = 'staff_grant'")).toBe(2);
    expect(await count('org.kyb_decision')).toBe(1);
    expect(await count('org.payout_account')).toBe(1);
    expect(await count('org.kyb_check')).toBe(7);
    expect(formatTable(await seed(target))).toContain(`Institution: ${INSTITUTION.name} (IL) ${institution!.id}`);
  }, 120_000);

  it('without a staff key the seed says how to get one and makes no institution', async () => {
    const { staffKey: _none, ...plain } = target;
    const result = await seed(plain);
    expect(result.institution).toBeUndefined();
    expect(formatTable(result)).toContain('ADMIN_API_SIGNING_KEY');
  }, 60_000);
});

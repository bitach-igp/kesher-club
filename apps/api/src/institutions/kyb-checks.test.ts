// T-0622 automated KYB checks (TST-INS-011, checks rows), over HTTP against the KybPort simulator:
// - with `institutions.kyb.checks` off, a run answers FEATURE_OFF and records nothing;
// - a clean amuta and its T2 chair come back clear on every check, with the provider and its references, and
//   the record then supports an approval;
// - a sanctioned board member is a hit that blocks until disposed of;
// - another registered name, a struck-off entry and a US school missing from IRS data are each recorded;
// - an outage records nothing at all, and a malformed identifier is refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { KybRecord } from './kyb.ts';

let db: TestDatabase;
let app: App;
let off: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const CLEO = { sub: 'compliance-cleo', roles: ['compliance'] };

const token = (who: { sub: string; roles: string[] }) =>
  new SignJWT({ roles: who.roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(who.sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (a: App, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(a, { method, url, headers: { authorization: `Bearer ${await token(CLEO)}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const runChecks = (inst: string, identifier: string, legalName = 'Yeshivat Example', a: App = app) => call(a, 'POST', `/v1/admin/institutions/${inst}/kyb/run`, { identifier, legalName });
const checkCount = async (inst: string) => Number((await db.query<{ n: number }>('select count(*)::int as n from org.kyb_check where institution_id = $1', [inst])).rows[0]!.n);

async function institution(market: 'IL' | 'US' = 'IL'): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', $2)`, [id, market]);
  return id;
}
async function person(inst: string, fullName: string, tier: 'T1' | 'T2' = 'T2'): Promise<string> {
  const party = uuidv7();
  await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, $3, 'IL', 'simulator', 'approved', $4, $4::timestamptz + interval '1 day', $4)`, [`kyc-${party}`, party, tier, NOW]);
  return ((await call(app, 'POST', `/v1/admin/institutions/${inst}/kyb/people`, { fullName, roles: ['board', 'control'], partyId: party }, `p-${inst}-${fullName}`)).body as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  const opts = { db, registry: new SimulatorHost().registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'institutions.kyb.checks': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags() });
}, 60_000);
afterAll(async () => db.close());

describe('automated KYB checks (T-0622, TST-INS-011)', () => {
  it('off, a run answers FEATURE_OFF and records nothing', async () => {
    const inst = await institution();
    expect((await runChecks(inst, '580123456', 'Yeshivat Example', off)).body).toMatchObject({ code: 'FEATURE_OFF' });
    expect(await checkCount(inst)).toBe(0);
  });

  it('a clean amuta and its T2 chair come back clear on every check, with the provider and its references; the record then supports an approval', async () => {
    const inst = await institution();
    const chair = await person(inst, 'Rav Chair Example');
    const r = await runChecks(inst, '580123456');
    expect(r.status).toBe(200);
    const record = r.body as KybRecord;
    expect(record.checks.map((c) => [c.kind, c.personId ?? 'institution', c.result, c.provider])).toEqual([
      ['exempt_status', 'institution', 'clear', 'simulator'],
      ['identifier', 'institution', 'clear', 'simulator'],
      ['pep', 'institution', 'clear', 'simulator'],
      ['pep', chair, 'clear', 'simulator'],
      ['registry', 'institution', 'clear', 'simulator'],
      ['sanctions', 'institution', 'clear', 'simulator'],
      ['sanctions', chair, 'clear', 'simulator'],
    ]);
    expect(record.checks.find((c) => c.kind === 'identifier')).toMatchObject({ evidenceRef: 'sim-registry:IL:580123456', detail: { identifier: '580123456', registeredName: 'Yeshivat Example' } });
    expect(record.checks.find((c) => c.kind === 'exempt_status')!.detail).toEqual({ status: 'shown', properManagementYear: 2026 });
    expect(record.checks.find((c) => c.kind === 'registry')!.detail).toMatchObject({ status: 'active', entityType: 'amuta' });
    expect(record.blocking).toEqual([]);
  });

  it('a sanctioned board member is a hit that blocks until disposed of', async () => {
    const inst = await institution();
    await person(inst, 'Rav Chair Example');
    const bad = await person(inst, 'Sanctioned Person Example');
    const record = (await runChecks(inst, '580123456')).body as KybRecord;
    const hit = record.checks.find((c) => c.kind === 'sanctions' && c.personId === bad)!;
    expect(hit).toMatchObject({ result: 'hit', evidenceRef: expect.stringContaining('sdn'), detail: { matches: [{ list: 'OFAC SDN', score: 0.92 }] } });
    expect(record.blocking).toEqual([`sanctions_hit_undisposed:${hit.id}`]);
  });

  it('another registered name, a struck-off entry and a US school missing from IRS data are each recorded as what they are', async () => {
    const other = (await runChecks(await institution(), '580123111')).body as KybRecord;
    expect(other.checks.find((c) => c.kind === 'identifier')).toMatchObject({ result: 'hit', detail: { registeredName: 'Another Registered Name', legalName: 'Yeshivat Example' } });
    expect(other.blocking).toContain('identifier_not_clear');
    const struck = (await runChecks(await institution(), '580123000')).body as KybRecord;
    expect(struck.checks.find((c) => c.kind === 'registry')).toMatchObject({ result: 'hit', detail: { status: 'struck_off' } });
    const church = (await runChecks(await institution('US'), '12-3456222', 'Day School Example')).body as KybRecord;
    expect(church.checks.find((c) => c.kind === 'exempt_status')).toMatchObject({ result: 'missing', detail: { status: 'not_found', possibleChurch: true } });
    expect(church.blocking).toContain('exempt_status_not_shown');
  });

  it('an outage records nothing at all; a malformed identifier or a missing name is refused; support cannot run checks', async () => {
    const inst = await institution();
    await person(inst, 'Rav Chair Example');
    expect((await runChecks(inst, '580123999')).body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await checkCount(inst)).toBe(0);
    expect((await runChecks(inst, '12345')).status).toBe(422);
    expect((await runChecks(inst, '580123456', ' ')).status).toBe(422);
    const support = await dispatch(app, { method: 'POST', url: `/v1/admin/institutions/${inst}/kyb/run`, headers: { authorization: `Bearer ${await token({ sub: 'sam', roles: ['support'] })}` }, rawBody: JSON.stringify({ identifier: '580123456', legalName: 'X' }), now: NOW });
    expect(support.status).toBe(403);
    expect(await checkCount(inst)).toBe(0);
  });
});

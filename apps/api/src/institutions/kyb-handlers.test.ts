// T-0620 KYB over HTTP (TST-INS-011, HTTP rows), through the dispatcher and PGlite. Compliance builds a record:
// people, a hand-made exception and screening results. An approval is refused with the blocking codes in the
// problem body, then succeeds. A support token reads but cannot decide, and a replayed key answers the same
// person and the same decision. A high-risk approval goes to a second compliance reviewer over HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const CLEO = { sub: 'compliance-cleo', roles: ['compliance'] };
const CARL = { sub: 'compliance-carl', roles: ['compliance'] };
const SAM = { sub: 'support-sam', roles: ['support'] };

const token = (who: { sub: string; roles: string[] }) =>
  new SignJWT({ roles: who.roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(who.sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${await token(who)}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });

async function institution(): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Day School', 'US')`, [id]);
  return id;
}
async function t2Member(): Promise<string> {
  const party = uuidv7();
  await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, 'T2', 'US', 'simulator', 'approved', $3, $3::timestamptz + interval '1 day', $3)`, [`kyc-${party}`, party, NOW]);
  return party;
}
/** A record ready for approval: checks clear by hand, exempt status excepted (a church school), one T2 control person screened clear. */
async function ready(inst: string): Promise<string> {
  for (const kind of ['registry', 'identifier', 'sanctions', 'pep']) await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/checks`, { kind, result: 'clear', evidenceRef: `kyb-file/${inst}/${kind}.pdf` });
  await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/checks`, { kind: 'exempt_status', result: 'excepted', reason: 'Church-integrated school, exempt without filing' });
  const person = (await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/people`, { fullName: 'Head of School', roles: ['control', 'signatory'], partyId: await t2Member() }, `person-${inst}`)).body as { id: string };
  for (const kind of ['sanctions', 'pep']) await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/checks`, { kind, personId: person.id, result: 'clear' });
  return person.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
}, 60_000);
afterAll(async () => db.close());

describe('KYB over HTTP (T-0620, TST-INS-011)', () => {
  it('compliance builds the record; an approval is refused with the blocking codes, then approved; support reads but cannot decide; keys replay', async () => {
    const inst = await institution();
    const empty = await call(SAM, 'GET', `/v1/admin/institutions/${inst}/kyb`);
    expect(empty).toMatchObject({ status: 200, body: { institutionId: inst, decision: { status: 'needs_more_info' }, people: [], checks: [] } });
    expect((empty.body as { blocking: string[] }).blocking).toContain('no_control_person');

    const person = await ready(inst);
    const again = await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/people`, { fullName: 'Head of School', roles: ['control'] }, `person-${inst}`);
    expect((again.body as { id: string }).id).toBe(person);

    const hit = (await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/checks`, { kind: 'sanctions', personId: person, result: 'hit', evidenceRef: 'screening/case-17' })).body as { id: string };
    const refused = await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/decisions`, { status: 'approved', risk: 'low', reasons: ['All clear'] }, `decide-${inst}-1`);
    expect(refused).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED', blocking: [`sanctions_hit_undisposed:${hit.id}`] } });

    expect((await call(SAM, 'POST', `/v1/admin/kyb/checks/${hit.id}/dispose`, { outcome: 'false_positive', note: 'x' })).status).toBe(403);
    const disposed = await call(CLEO, 'POST', `/v1/admin/kyb/checks/${hit.id}/dispose`, { outcome: 'false_positive', note: 'Different date of birth' });
    expect(disposed.body).toMatchObject({ id: hit.id, disposition: { outcome: 'false_positive', note: 'Different date of birth' } });

    expect((await call(SAM, 'POST', `/v1/admin/institutions/${inst}/kyb/decisions`, { status: 'approved', risk: 'low' }, `decide-${inst}-sam`)).status).toBe(403);
    const approved = await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/decisions`, { status: 'approved', risk: 'low', reasons: ['All clear'] }, `decide-${inst}-2`);
    expect(approved).toMatchObject({ status: 201, body: { decision: { status: 'approved', risk: 'low' } } });
    expect((await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/decisions`, { status: 'approved', risk: 'low' }, `decide-${inst}-2`)).body).toMatchObject({ decision: { status: 'approved' } });
    const record = (await call(SAM, 'GET', `/v1/admin/institutions/${inst}/kyb`)).body as { blocking: string[]; checks: { kind: string; result: string; provider: string }[] };
    expect(record.blocking).toEqual([]);
    expect(record.checks.find((c) => c.kind === 'exempt_status')).toMatchObject({ result: 'excepted', provider: 'compliance' });
  });

  it('a high-risk approval answers an approval request; the proposer cannot approve it and a second compliance reviewer can', async () => {
    const inst = await institution();
    await ready(inst);
    const proposed = await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/decisions`, { status: 'approved', risk: 'high', reasons: ['Foreign funding; EDD complete'] }, `decide-${inst}-high`);
    const approval = (proposed.body as { approval: { id: string; status: string; kind: string } }).approval;
    expect(approval).toMatchObject({ kind: 'kyb_decision', status: 'awaiting_second_approval' });
    expect(((await call(SAM, 'GET', `/v1/admin/institutions/${inst}/kyb`)).body as { pendingApproval?: { id: string } }).pendingApproval?.id).toBe(approval.id);
    expect((await call(CLEO, 'POST', `/v1/admin/kyb/decisions/${approval.id}/approve`)).status).toBe(409);
    const second = await call(CARL, 'POST', `/v1/admin/kyb/decisions/${approval.id}/approve`);
    expect(second).toMatchObject({ status: 200, body: { approval: { status: 'approved' }, decision: { status: 'approved', risk: 'high' } } });
  });

  it('refuses bad input before writing, and an unknown institution or check is 404', async () => {
    const inst = await institution();
    expect((await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/checks`, { kind: 'credit_score', result: 'clear' })).status).toBe(422);
    expect((await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/checks`, { kind: 'exempt_status', result: 'excepted' })).status).toBe(422);
    expect((await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/people`, { fullName: 'X', roles: ['owner'] }, `bad-${inst}`)).status).toBe(422);
    expect((await call(CLEO, 'POST', `/v1/admin/institutions/${inst}/kyb/people`, { fullName: 'X', roles: ['board'] })).status).toBe(422);
    expect((await call(CLEO, 'GET', `/v1/admin/institutions/${uuidv7()}/kyb`)).status).toBe(404);
    expect((await call(CLEO, 'POST', `/v1/admin/kyb/checks/${uuidv7()}/dispose`, { outcome: 'false_positive', note: 'x' })).status).toBe(404);
  });
});

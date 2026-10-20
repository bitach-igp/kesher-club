// T-0621 the KYB gate (TST-INS-010, REQ-INS-010, ADR-017):
// - needs_more_info: a ₪20,000.00 deposit approval answers FEATURE_OFF, the deposit stays pending and the
//   balance stays 0;
// - approved_with_limits: a ₪800.00 allowance runs within the balance, a run needing credit is refused even
//   with an approved limit, and a new limit is refused;
// - rejected: a payout is refused;
// - approved: everything opens.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { DomainError, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';
import { PostgresAllowanceActivities } from './allowance/activities.ts';
import { run } from './allowance/workflow.ts';
import { OPEN } from './kyb-gate.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
let activities: PostgresAllowanceActivities;
const NOW = new Date('2026-11-10T09:00:00Z');
const FINANCE = uuidv7(NOW);
const A = { sub: 'finance-a', roles: ['finance'] };
const B = { sub: 'finance-b', roles: ['finance'] };

const token = (who: { sub: string; roles: string[] }) =>
  new SignJWT({ roles: who.roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(who.sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${await token(who)}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const balance = async (inst: string) => (await app.services.accounts.institutionBalance(inst, 'ILS')).minor;
const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DomainError);
  return e as DomainError;
};

async function institution(heldMinor = 0n): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [id]);
  if (heldMinor > 0n) {
    const s = app.services;
    await s.ledger.post({ idempotencyKey: `fund:${id}:settle`, kind: 'deposit', effectiveAt: NOW, postings: [{ accountId: await s.accounts.systemAccount('partner_settlement', 'ILS'), currency: 'ILS', amountMinor: heldMinor }, { accountId: await s.accounts.institutionAccount(id, 'ILS'), currency: 'ILS', amountMinor: -heldMinor }], metadata: { institutionId: id } });
  }
  return id;
}
async function schedule(inst: string, amountMinor: bigint, count: number): Promise<string> {
  const id = uuidv7();
  const members: string[] = [];
  for (let i = 0; i < count; i++) {
    const party = uuidv7();
    members.push(party);
    await app.services.accounts.provisionMember(party);
    await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, $3, $4, 'active')`, [uuidv7(), inst, `Student ${i}`, party]);
  }
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, member_filter, created_by) values ($1, $2, 'Weekly', $3, 'ILS', 'weekly', $4, $5)`, [id, inst, amountMinor.toString(), JSON.stringify(members), FINANCE]);
  return id;
}
/** A ₪5,000.00 limit, set while the institution was approved (REQ-INS-008's two admins). */
async function limit(inst: string): Promise<void> {
  const admin = (sub: string) => ({ sub, roles: ['admin'] });
  const proposed = await call(admin('admin-a'), 'POST', `/v1/admin/institutions/${inst}/credit-limits`, { limit: { minor: '500000', currency: 'ILS' }, reason: 'Board-approved credit line' }, `limit-${inst}`);
  await call(admin('admin-b'), 'POST', `/v1/admin/credit-limits/${(proposed.body as { request: { id: string } }).request.id}/approve`);
}

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW, flags: new StaticFlags(undefined, { 'institutions.money': true, 'institutions.deposits': true, 'payouts.nium': true }) });
  const s = app.services;
  activities = new PostgresAllowanceActivities(db, s.ledger, s.accounts, s.approvals, s.transfers, s.institutionCredit, () => NOW);
}, 60_000);
afterAll(async () => db.close());

describe('the KYB gate (T-0621, TST-INS-010)', () => {
  it('opens what ADR-017 says, and nothing before a decision', () => {
    expect(OPEN).toEqual({ needs_more_info: [], approved_with_limits: ['deposits', 'allowances', 'payouts'], approved: ['deposits', 'allowances', 'credit', 'payouts'], rejected: [] });
  });

  it('needs_more_info: the second approval of a ₪20,000.00 deposit answers FEATURE_OFF, the deposit stays pending, the balance stays 0', async () => {
    const inst = await institution();
    const recorded = (await call(A, 'POST', `/v1/admin/institutions/${inst}/deposits`, { amount: { minor: '2000000', currency: 'ILS' }, rail: 'masav', bankReference: `FT-${inst.slice(-6)}`, valueDate: '2026-11-09' }, `dep-${inst}`)).body as { id: string; status: string };
    expect(recorded.status).toBe('pending');
    const refused = await call(B, 'POST', `/v1/admin/deposits/${recorded.id}/approve`);
    expect(refused).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF', kyb: 'needs_more_info', capability: 'deposits' } });
    expect((await db.query<{ status: string }>('select status from ops.institution_deposit where id = $1', [recorded.id])).rows[0]!.status).toBe('pending');
    expect(await balance(inst)).toBe(0n);
    // Once approved, the same approval posts it.
    await decideKyb(db, inst);
    expect((await call(B, 'POST', `/v1/admin/deposits/${recorded.id}/approve`)).body).toMatchObject({ status: 'posted' });
    expect(await balance(inst)).toBe(2_000_000n);
  });

  it('approved_with_limits: a ₪800.00 run within the balance pays; a run needing credit is refused even with an approved limit; a new limit is refused', async () => {
    const inst = await institution(100_000n);
    await decideKyb(db, inst, 'approved');
    await limit(inst);
    await decideKyb(db, inst, 'approved_with_limits', 'medium');
    expect(await run(activities, await schedule(inst, 40_000n, 2), '2026-11-10', FINANCE)).toMatchObject({ status: 'completed', paid: 2 });
    expect(await balance(inst)).toBe(20_000n);
    const e = await refusal(run(activities, await schedule(inst, 30_000n, 1), '2026-11-10', FINANCE));
    expect(e).toMatchObject({ code: 'INSUFFICIENT_FUNDS', extra: { creditLimit: { minor: '0' }, creditClosed: true } });
    expect(e.message).toContain('no credit until the institution\'s KYB is fully approved');
    const proposed = await call({ sub: 'admin-a', roles: ['admin'] }, 'POST', `/v1/admin/institutions/${inst}/credit-limits`, { limit: { minor: '900000', currency: 'ILS' }, reason: 'Raise' }, `limit2-${inst}`);
    expect(proposed.body).toMatchObject({ code: 'FEATURE_OFF', kyb: 'approved_with_limits', capability: 'credit' });
  });

  it('needs_more_info and rejected refuse allowance runs and payouts; approved opens them', async () => {
    const inst = await institution(500_000n);
    const sched = await schedule(inst, 10_000n, 1);
    expect(await refusal(run(activities, sched, '2026-11-10', FINANCE))).toMatchObject({ code: 'FEATURE_OFF', extra: { kyb: 'needs_more_info', capability: 'allowances' } });
    const payout = (key: string) => app.services.payouts.request(inst, { payee: { iban: 'IL620108000000099999999', name: 'Building Supplies Ltd' }, amount: { minor: '10000', currency: 'ILS' }, reference: 'roof' }, key, NOW, { kind: 'institution', requestedBy: FINANCE, requesterRole: 'finance' });
    await decideKyb(db, inst, 'rejected');
    expect(await refusal(payout(`po-${inst}-1`))).toMatchObject({ code: 'FEATURE_OFF', extra: { kyb: 'rejected', capability: 'payouts' } });
    await decideKyb(db, inst, 'approved');
    expect(await run(activities, sched, '2026-11-10', FINANCE)).toMatchObject({ status: 'completed', paid: 1 });
    expect((await payout(`po-${inst}-2`)).state).not.toBe('failed');
  });
});

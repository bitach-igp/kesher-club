// TST-INS-006 billing rows (T-0629): finance bills a fee to every active member, or a listed few, from I08. Staff
// who are not finance get 403, another institution's finance 404, and with institutions.money off FEATURE_OFF; a
// zero or over-10,000.00 amount, a past due date or a listed member who is not active answers 422; a batch makes
// one due item per member, which the member lists and pays; a retried key makes nothing new.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import type { FeeItemView } from './collections.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens = { finance: '', staff: '', otherFinance: '' };
let student = { partyId: '', access: '', stepUp: '' };
const members: { id: string; partyId: string }[] = [];

const bill = (token: string, body: unknown, key = `bill-${uuidv7()}`, a: App = app) =>
  dispatch(a, { method: 'POST', url: `/v1/institutions/${INST}/fee-items`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, rawBody: JSON.stringify(body), now: NOW });
const tuition = (minor: string, over: Record<string, unknown> = {}) => ({ description: 'Tuition, term 2', amount: { minor, currency: 'ILS' }, dueDate: '2026-12-01', members: { kind: 'all' }, ...over });
const items = async (batch: string) => (await db.query<{ member_party_id: string; status: string; amount_minor: string }>('select member_party_id, status, amount_minor::text from org.fee_item where batch_id = $1 order by member_party_id', [batch])).rows;

/** A member signed up with a passkey and a step-up, so they can pay a fee item themselves. */
async function signUp(phone: string): Promise<{ partyId: string; access: string; stepUp: string }> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `phone-${phone}`, deviceName: 'Phone' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `phone-${phone}`, deviceName: 'Phone', response: await device.register(r1.options!) });
  const principal = await s.tokens.verifyAccess(r2.tokens!.accessToken);
  const su = await s.stepUp.start(principal);
  return { partyId: principal.partyId, access: r2.tokens!.accessToken, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const opts = { db, registry: host.registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'institutions.money': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags() });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Other', 'IL')`, [INST, OTHER]);
  student = await signUp('+972509100001');
  await runLoad(app.services.loads, { payerPartyId: student.partyId, memberPartyId: student.partyId, method: 'card', amount: money(100_000n, 'ILS'), paymentMethodId: 'pm_ok' }, 'bill-fund', NOW);
  // Three active members (the first is the signed-up student), one verified, one still invited.
  for (const [status, party] of [['active', student.partyId], ['active', uuidv7()], ['active', uuidv7()], ['verified', uuidv7()], ['invited', null]] as const) {
    const id = uuidv7();
    await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, 'Student', $3, $4)`, [id, INST, party, status]);
    members.push({ id, partyId: party ?? '' });
  }
  const [finance, staff, otherFinance] = [uuidv7(), uuidv7(), uuidv7()];
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $4, 'finance'), ($2, $4, 'staff'), ($3, $5, 'finance')`, [finance, staff, otherFinance, INST, OTHER]);
  const issue = async (partyId: string, role: string) => (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: [role] })).accessToken;
  tokens.finance = await issue(finance, 'org_finance');
  tokens.staff = await issue(staff, 'org_staff');
  tokens.otherFinance = await issue(otherFinance, 'org_finance');
}, 60_000);
afterAll(async () => db.close());

describe('POST /institutions/{id}/fee-items (TST-INS-006 billing, T-0629)', () => {
  it('staff who are not finance get 403; another institution\'s finance 404; with institutions.money off FEATURE_OFF', async () => {
    expect((await bill(tokens.staff, tuition('12000'))).status).toBe(403);
    expect((await bill(tokens.otherFinance, tuition('12000'))).status).toBe(404);
    expect((await bill(tokens.finance, tuition('12000'), 'bill-off-1', off)).body).toMatchObject({ code: 'FEATURE_OFF' });
  });

  it('a zero or over-10,000.00 amount, the wrong currency, a past or far due date, or a member who is not active answers 422', async () => {
    for (const minor of ['0', '1000001', '-1', '1.5']) expect((await bill(tokens.finance, tuition(minor))).status, minor).toBe(422);
    expect((await bill(tokens.finance, tuition('12000', { amount: { minor: '12000', currency: 'USD' } }))).status).toBe(422);
    for (const dueDate of ['2026-11-09', '2027-11-12', '2026-02-30', 'soon']) expect((await bill(tokens.finance, tuition('12000', { dueDate }))).status, dueDate).toBe(422);
    expect((await bill(tokens.finance, tuition('12000', { description: '  ' }))).status).toBe(422);
    for (const other of [members[3]!.id, members[4]!.id, uuidv7()]) {
      const r = await bill(tokens.finance, tuition('12000', { members: { kind: 'listed', memberIds: [members[0]!.id, other] } }));
      expect(r.body).toMatchObject({ code: 'VALIDATION_FAILED', notActive: [other] });
    }
    expect(await db.query('select 1 from org.fee_item')).toMatchObject({ rows: [] });
  });

  it('every active member gets one due item; the student lists it and pays it from their purse', async () => {
    const r = await bill(tokens.finance, tuition('12000', { dueDate: '2026-11-10' }), 'bill-all-1');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), description: 'Tuition, term 2', amount: { minor: '12000', currency: 'ILS' }, dueDate: '2026-11-10', memberCount: 3, total: { minor: '36000', currency: 'ILS' } });
    const made = await items((r.body as { id: string }).id);
    expect(made.map((x) => x.member_party_id).sort()).toEqual(members.slice(0, 3).map((m) => m.partyId).sort());
    expect(made.every((x) => x.status === 'due' && x.amount_minor === '12000')).toBe(true);

    const listed = await dispatch(app, { method: 'GET', url: '/v1/fee-items', headers: { authorization: `Bearer ${student.access}` }, rawBody: '', now: NOW });
    const due = (listed.body as { items: FeeItemView[] }).items.find((i) => i.description === 'Tuition, term 2')!;
    expect(due).toMatchObject({ status: 'due', amount: { minor: '12000', currency: 'ILS' }, institutionName: 'Yeshivat Example' });
    const paid = await dispatch(app, { method: 'POST', url: `/v1/fee-items/${due.id}/pay`, headers: { authorization: `Bearer ${student.access}`, 'idempotency-key': `pay-${due.id}`, 'x-step-up': student.stepUp }, rawBody: '', now: NOW });
    expect(paid.status).toBe(200);
    expect((await app.services.accounts.purses(student.partyId)).find((p) => p.currency === 'ILS')!.available.minor).toBe(88_000n);
  });

  it('a listed few get one each; a retried key answers the same batch and makes nothing new; another body with it is a conflict', async () => {
    const body = tuition('5000', { description: 'Trip', members: { kind: 'listed', memberIds: [members[1]!.id, members[2]!.id] } });
    const first = await bill(tokens.finance, body, 'bill-few-1');
    expect(first.body).toMatchObject({ memberCount: 2, total: { minor: '10000', currency: 'ILS' } });
    const again = await bill(tokens.finance, { ...body, members: { kind: 'listed', memberIds: [members[2]!.id, members[1]!.id] } }, 'bill-few-1');
    expect(again.body).toEqual(first.body);
    expect(await items((first.body as { id: string }).id)).toHaveLength(2);
    expect((await bill(tokens.finance, { ...body, description: 'Another trip' }, 'bill-few-1')).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await db.query<{ n: number }>('select count(*)::int as n from org.fee_batch')).rows[0]!.n).toBe(2);
  });
});

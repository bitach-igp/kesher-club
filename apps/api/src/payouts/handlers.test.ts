// T-0527 institution payouts over HTTP (TST-PO-001, TST-PO-002, TST-INS-004): the yeshiva's finance staff
// pay out of its own account (T-0613) and list its payouts; over ₪5,000 a second finance member approves,
// never the requester; a rejected payout ends with no journal; replaying an approve is a no-op; another
// institution's staff get 404; the account never goes below zero; the export reads the payout.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type PayoutSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { monthlyExport } from '../institutions/export.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import { settleKey } from './service.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-10T09:00:00Z');
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const IBAN = 'IL620108000000099999999';
const staff: Record<'one' | 'two' | 'other', { partyId: string; access: string; stepUp: string }> = { one: { partyId: '', access: '', stepUp: '' }, two: { partyId: '', access: '', stepUp: '' }, other: { partyId: '', access: '', stepUp: '' } };
let memberAccess = '';

type Item = { id: string; state: string; amount: { minor: string }; payee: { name: string; ibanLast4: string }; requestedBy?: { displayName: string }; approvedBy: { displayName: string }[]; requiredApprovals: number; requestedByMe: boolean; coolOffEndsAt?: string; failureCode?: string };

const call = (who: { access: string; stepUp?: string }, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${who.access}`, ...(who.stepUp !== undefined ? { 'x-step-up': who.stepUp } : {}), ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const pay = (who: { access: string; stepUp: string }, minor: string, key: string, inst = INST) => call(who, 'POST', `/v1/institutions/${inst}/payouts`, { payee: { iban: IBAN, name: 'Building Supplies Ltd' }, amount: { minor, currency: 'ILS' }, reference: 'roof repair' }, key);
const list = async (who: { access: string }, query = '') => (await call(who, 'GET', `/v1/institutions/${INST}/payouts${query}`)).body as { items: Item[]; nextCursor?: string; available: { minor: string } };
const sim = () => host.simulators.payout as PayoutSimulator;
const hook = (w: { headers: Record<string, string>; rawBody: string }) => dispatch(app, { method: 'POST', url: '/v1/hooks/payout', headers: w.headers, rawBody: w.rawBody, now: NOW });
const vendorPayoutOf = async (transferId: string) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'transfer' and provider = 'simulator' and entity_id = $1`, [transferId])).rows[0]?.external_id;
const balance = async () => (await app.services.accounts.institutionBalance(INST, 'ILS')).minor;

/** Signs a person up with OTP and a passkey; their token carries `roles`, and they hold a fresh step-up. */
async function person(phone: string, roles: string[]): Promise<{ partyId: string; access: string; stepUp: string }> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  return { partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'payouts.nium': true, 'institutions.money': true }) });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Other', 'IL')`, [INST, OTHER]);
  staff.one = await person('+972501240001', ['org_finance']);
  staff.two = await person('+972501240002', ['org_finance']);
  staff.other = await person('+972501240003', ['org_finance']);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $4, 'finance'), ($2, $4, 'finance'), ($3, $5, 'finance')`, [staff.one.partyId, staff.two.partyId, staff.other.partyId, INST, OTHER]);
  // The yeshiva holds ₪20,000: a member's fee, posted the way collections posts it, into its own account.
  const member = await person('+972501240009', ['member']);
  memberAccess = member.access;
  await runLoad(app.services.loads, { payerPartyId: member.partyId, memberPartyId: member.partyId, method: 'card', amount: money(2_000_000n, 'ILS'), paymentMethodId: 'pm_ok' }, 'fund-member', NOW);
  const wallet = await app.services.accounts.memberAccount(member.partyId, 'wallet', 'ILS');
  const own = await app.services.accounts.institutionAccount(INST, 'ILS');
  await app.services.ledger.post({ idempotencyKey: 'fee:fund-inst', kind: 'fee', effectiveAt: NOW, postings: [{ accountId: wallet, currency: 'ILS', amountMinor: 2_000_000n }, { accountId: own, currency: 'ILS', amountMinor: -2_000_000n }], metadata: { institutionId: INST, memberPartyId: member.partyId, feeItemId: uuidv7(NOW) } });
}, 60_000);
afterAll(async () => db.close());

describe('institution payouts (T-0527)', () => {
  it('finance lists the payouts and what the account holds; another institution gets 404, a member 403', async () => {
    expect(await list(staff.one)).toEqual({ items: [], available: { minor: '2000000', currency: 'ILS' } });
    expect((await call(staff.other, 'GET', `/v1/institutions/${INST}/payouts`)).status).toBe(404);
    expect((await call({ access: memberAccess }, 'GET', `/v1/institutions/${INST}/payouts`)).status).toBe(403);
  });

  it('₪2,000 to a new payee pays out of the institution account at once, and the export reads it', async () => {
    const r = await pay(staff.one, '200000', 'inst-po-1');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: 'processing', amount: { minor: '200000' }, payee: { name: 'Building Supplies Ltd', ibanLast4: '9999' }, reference: 'roof repair', requiredApprovals: 1, approvedBy: [{ displayName: 'Finance •••• 0001' }], requestedBy: { displayName: 'Finance •••• 0001' }, requestedByMe: true });
    expect(await balance()).toBe(1_800_000n);
    const po = (await vendorPayoutOf((r.body as Item).id))!;
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect((await list(staff.two)).items[0]).toMatchObject({ state: 'settled', requestedByMe: false });
    const e = await monthlyExport(db, INST, '2026-11', 'ILS');
    expect(e.rows.find((x) => x.kind === 'payout')).toMatchObject({ amount: money(-200_000n, 'ILS'), description: 'Payout to Building Supplies Ltd •••• 9999: roof repair' });
    expect(e.totals.payoutsOut).toEqual(money(-200_000n, 'ILS'));
  });

  it('over ₪5,000 it waits; the requester cannot approve; a second finance member can and it submits; approving again is a no-op', async () => {
    const r = await pay(staff.one, '600000', 'inst-po-2');
    const id = (r.body as Item).id;
    expect(r.body).toMatchObject({ state: 'awaiting_second_approval', requiredApprovals: 2, approvedBy: [{ displayName: 'Finance •••• 0001' }] });
    expect(await balance()).toBe(1_800_000n);
    const self = await call(staff.one, 'POST', `/v1/payouts/${id}/approve`, undefined, 'approve-self-1');
    expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await call({ access: staff.two.access, stepUp: '' }, 'POST', `/v1/payouts/${id}/approve`, undefined, 'approve-2-nostep')).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const approved = await call(staff.two, 'POST', `/v1/payouts/${id}/approve`, undefined, 'approve-2-1');
    expect(approved.body).toMatchObject({ state: 'processing', approvedBy: [{ displayName: 'Finance •••• 0001' }, { displayName: 'Finance •••• 0002' }], requestedByMe: false });
    expect(await balance()).toBe(1_200_000n);
    const again = await call(staff.two, 'POST', `/v1/payouts/${id}/approve`, undefined, 'approve-2-2');
    expect(again.body).toMatchObject({ state: 'processing' });
    expect(await balance()).toBe(1_200_000n);
    expect((await call(staff.other, 'POST', `/v1/payouts/${id}/approve`, undefined, 'approve-other')).status).toBe(404);
  });

  it('a rejected payout ends with no journal and needs a reason; nothing more can be decided on it', async () => {
    const r = await pay(staff.one, '700000', 'inst-po-3');
    const id = (r.body as Item).id;
    expect((await call(staff.two, 'POST', `/v1/payouts/${id}/reject`, { reason: ' ' }, 'reject-blank')).status).toBe(422);
    const rejected = await call(staff.two, 'POST', `/v1/payouts/${id}/reject`, { reason: 'Wrong supplier' }, 'reject-1');
    expect(rejected.body).toMatchObject({ state: 'rejected', failureCode: 'REJECTED' });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey('inst-po-3')])).rows[0]!.n).toBe(0);
    expect(await balance()).toBe(1_200_000n);
    expect((await call(staff.two, 'POST', `/v1/payouts/${id}/reject`, { reason: 'Wrong supplier' }, 'reject-2')).body).toMatchObject({ state: 'rejected' });
    expect((await call(staff.two, 'POST', `/v1/payouts/${id}/approve`, undefined, 'approve-after-reject')).status).toBe(409);
  });

  it('never more than the account holds; another institution cannot pay out of this one', async () => {
    expect((await pay(staff.one, '1200001', 'inst-po-4')).body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await pay(staff.other, '100000', 'inst-po-5')).status).toBe(404);
    expect(await balance()).toBe(1_200_000n);
  });

  it('pages with a cursor: the pages do not overlap and together hold every payout; a forged cursor is refused', async () => {
    // Every payout here was made at the same instant, so their order within it is the ids' tie; the pages still partition them.
    const all = (await list(staff.one)).items.map((i) => i.id);
    expect(all).toHaveLength(3);
    const first = await list(staff.one, '?limit=2');
    const second = await list(staff.one, `?limit=2&cursor=${first.nextCursor}`);
    expect(first.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.items, ...second.items].map((i) => i.id).sort()).toEqual([...all].sort());
    expect((await call(staff.one, 'GET', `/v1/institutions/${INST}/payouts?cursor=nope`)).status).toBe(422);
  });
});

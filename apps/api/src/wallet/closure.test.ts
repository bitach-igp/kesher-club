// Closure (T-0504, REQ-WAL-005) end to end over the funding simulator. TST-WAL-005: closing with $30
// initiates a refund to the funder's source through FundingPort.refund and the close completes only
// after the refund journal posts; a zero balance closes at once. Also: holds and an overdrawn purse
// block; a refused refund blocks with the reason; a pending refund closes on the next read once the
// vendor confirms; money with no load behind it waits on a payout; a closed account no longer signs in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { refundKey, refundSettleKey, type ClosureView } from './closure.ts';
import { runLoad } from './loads.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-02T09:00:00Z');

interface Member {
  partyId: string;
  access: string;
  stepUp: string;
  device: SimPasskeyDevice;
}

async function register(phone: string): Promise<Member> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana', response: await device.register(r1.options!) });
  const access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  const stepUp = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
  return { partyId: principal.partyId, access, stepUp, device };
}

const close = (m: Member, key = 'closure-1') => dispatch(app, { method: 'POST', url: '/v1/me/closure', headers: { authorization: `Bearer ${m.access}`, 'idempotency-key': key, 'x-step-up': m.stepUp }, rawBody: '', now: NOW });
const status = (m: Member) => dispatch(app, { method: 'GET', url: '/v1/me/closure', headers: { authorization: `Bearer ${m.access}` }, rawBody: '', now: NOW });
const load = (m: Member, minor: bigint, pm = 'pm_ok', key = `load-${m.partyId}-${minor}-${pm}`) => runLoad(app.services.loads, { payerPartyId: m.partyId, memberPartyId: m.partyId, method: 'card', amount: money(minor, 'USD'), paymentMethodId: pm }, key, NOW);
const usd = async (partyId: string) => (await app.services.accounts.purses(partyId)).find((p) => p.currency === 'USD')!;
/** Moves a purse's cached balance as a card spend or an incoming transfer would (the cache row may not exist yet). */
const bump = (accountId: string, delta: bigint) => db.query(`insert into ops.account_balance (account_id, balance_minor) values ($1, $2) on conflict (account_id) do update set balance_minor = ops.account_balance.balance_minor + excluded.balance_minor`, [accountId, delta.toString()]);
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  app = createApp({ db, registry: host.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
}, 60_000);
afterAll(async () => db.close());

describe('TST-WAL-005', () => {
  it('closing with $30 refunds it to the source of the load and closes only once the refund journal posts', async () => {
    const m = await register('+12125550201');
    const l = await load(m, 3_000n);
    expect((await usd(m.partyId)).available.minor).toBe(3_000n);
    expect((await close(m, 'x')).status).toBe(422); // the key is required
    expect((await dispatch(app, { method: 'POST', url: '/v1/me/closure', headers: { authorization: `Bearer ${m.access}`, 'idempotency-key': 'closure-nostep' }, rawBody: '', now: NOW })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const r = await close(m);
    expect(r.status).toBe(200);
    const view = r.body as ClosureView;
    expect(view).toMatchObject({ state: 'closed', closedAt: NOW.toISOString(), balances: [{ currency: 'USD', available: { minor: '0' } }, { currency: 'ILS', available: { minor: '0' } }], refunds: [{ amount: { minor: '3000', currency: 'USD' }, state: 'settled' }] });
    const key = refundKey(m.partyId, l.transfer.id);
    const refund = (await app.services.transfers.byKey(key))!;
    expect(refund).toMatchObject({ kind: 'refund', state: 'settled', fromPartyId: m.partyId, amount: money(3_000n, 'USD') });
    expect((await app.services.transfers.history(refund.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
    const sides = (await db.query<{ type: string; amount_minor: string }>(`select a.type::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by a.type::text`, [refund.journalId])).rows;
    expect(sides).toEqual([
      { type: 'partner_settlement', amount_minor: '-3000' },
      { type: 'wallet', amount_minor: '3000' },
    ]);
    expect(await journals(refundSettleKey(key))).toBe(1);
    const vendorLoad = (await app.services.loads.vendorLoadOf(l.transfer.id))!;
    const vendorRefund = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'refund' and entity_id = $1`, [refund.id])).rows[0]!.external_id;
    expect(await host.simulators.funding.getRefund(vendorRefund)).toMatchObject({ loadId: vendorLoad, amount: money(3_000n, 'USD'), status: 'succeeded' });
    expect((await app.services.identity.findUser(m.partyId))!.status).toBe('closed');
    expect((await db.query<{ n: number }>(`select count(*)::int as n from audit.entry where action = 'account.closed' and subject = $1`, [m.partyId])).rows[0]).toEqual({ n: 1 });

    // Idempotent: the same call, and a read, report closed without a second refund.
    expect((await close(m)).body).toMatchObject({ state: 'closed', refunds: [{ state: 'settled' }] });
    expect((await status(m)).body).toMatchObject({ state: 'closed' });
    expect(await journals(refundSettleKey(key))).toBe(1);
    // The closed account no longer signs in: the passkey ceremony is refused at verification.
    const a1 = await app.services.passkeys.authenticate({ deviceId: 'iphone-1' });
    await expect(app.services.passkeys.authenticate({ deviceId: 'iphone-1', response: await m.device.authenticate(a1.options!) })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a zero balance closes at once, with no refund', async () => {
    const m = await register('+12125550202');
    expect((await status(m)).body).toMatchObject({ state: 'open', refunds: [] });
    const r = await close(m);
    expect(r.body).toMatchObject({ state: 'closed', refunds: [] });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'refund' and from_party_id = $1`, [m.partyId])).rows[0]).toEqual({ n: 0 });
  });

  it('refunds newest load first and only up to what each gave; spent money comes back across loads', async () => {
    const m = await register('+12125550203');
    const a = await load(m, 10_000n, 'pm_ok', 'closure-multi-a');
    const b = await load(m, 2_000n, 'pm_ok', 'closure-multi-b');
    // Spent $9,500 on a card: the ledger shows $2,500 left.
    const wallet = (await usd(m.partyId)).id;
    await bump(wallet, 9_500n);
    expect((await usd(m.partyId)).available.minor).toBe(2_500n);
    const r = (await close(m)).body as ClosureView;
    expect(r.state).toBe('closed');
    const rb = (await app.services.transfers.byKey(refundKey(m.partyId, b.transfer.id)))!;
    const ra = (await app.services.transfers.byKey(refundKey(m.partyId, a.transfer.id)))!;
    expect(rb).toMatchObject({ state: 'settled', amount: money(2_000n, 'USD') });
    expect(ra).toMatchObject({ state: 'settled', amount: money(500n, 'USD') });
    expect((await usd(m.partyId)).available.minor).toBe(0n);
  });

  it('holds and an overdrawn purse block the closure; a disabled auto-reload rule is left off', async () => {
    const m = await register('+12125550204');
    await load(m, 1_000n);
    const purse = await usd(m.partyId);
    await app.services.autoReload.set(m.partyId, purse.id, { threshold: { minor: '5000', currency: 'USD' }, target: { minor: '20000', currency: 'USD' }, method: 'card', paymentMethodId: 'pm_ok' }, NOW);
    const pending = await app.services.accounts.memberAccount(m.partyId, 'pending', 'USD');
    await bump(pending, -400n);
    expect((await close(m)).body).toMatchObject({ state: 'blocked', blockedReason: 'HOLDS_OUTSTANDING', refunds: [] });
    await bump(pending, 400n);
    await bump(purse.id, 1_500n);
    expect((await usd(m.partyId)).available.minor).toBe(-500n);
    expect((await close(m)).body).toMatchObject({ state: 'blocked', blockedReason: 'OVERDRAWN', refunds: [] });
    expect((await app.services.identity.findUser(m.partyId))!.status).toBe('active');
    expect((await app.services.autoReload.byAccount(purse.id))!.enabled).toBe(true);
    await bump(purse.id, -1_500n);
    expect((await close(m)).body).toMatchObject({ state: 'closed' });
    expect((await app.services.autoReload.byAccount(purse.id))!.enabled).toBe(false);
  });

  it('a refund the vendor refuses blocks the closure with the failure; money with no load behind it waits on a payout', async () => {
    const m = await register('+12125550205');
    await load(m, 2_000n, 'pm_norefund');
    const r = (await close(m)).body as ClosureView;
    expect(r).toMatchObject({ state: 'blocked', blockedReason: 'REFUND_FAILED', refunds: [{ amount: { minor: '2000' }, state: 'failed', failureCode: 'REFUND_REFUSED' }] });
    expect((await usd(m.partyId)).available.minor).toBe(2_000n);
    expect((await app.services.identity.findUser(m.partyId))!.status).toBe('active');
    // Asked again: the failed refund is final for that load, nothing else to try.
    expect((await close(m)).body).toMatchObject({ state: 'blocked', refunds: [{ state: 'failed' }] });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'refund' and from_party_id = $1`, [m.partyId])).rows[0]).toEqual({ n: 1 });

    const p = await register('+12125550206');
    // Money that arrived without a load (a transfer in): nothing to refund against.
    const wallet = (await usd(p.partyId)).id;
    await bump(wallet, -700n);
    expect((await close(p)).body).toMatchObject({ state: 'blocked', blockedReason: 'NO_REFUND_SOURCE', refunds: [] });
  });

  it('a refund the vendor takes time over leaves the closure refunding; the next read settles it and closes', async () => {
    const m = await register('+12125550207');
    await load(m, 4_500n, 'pm_slowrefund');
    const r = (await close(m)).body as ClosureView;
    expect(r).toMatchObject({ state: 'refunding', refunds: [{ amount: { minor: '4500' }, state: 'pending' }] });
    expect((await usd(m.partyId)).available.minor).toBe(4_500n);
    expect((await status(m)).body).toMatchObject({ state: 'refunding' });
    expect((await close(m)).body).toMatchObject({ state: 'refunding', refunds: [{ state: 'pending' }] });
    const refundId = (await db.query<{ external_id: string }>(`select x.external_id from ops.external_ref x join ops.transfer t on t.id = x.entity_id where x.entity_type = 'refund' and t.from_party_id = $1`, [m.partyId])).rows[0]!.external_id;
    host.simulators.funding.settleRefund(refundId);
    const done = (await status(m)).body as ClosureView;
    expect(done).toMatchObject({ state: 'closed', refunds: [{ state: 'settled' }] });
    expect((await usd(m.partyId)).available.minor).toBe(0n);
    expect((await app.services.identity.findUser(m.partyId))!.status).toBe('closed');
    expect(uuidv7(NOW)).toBeTruthy();
  });
});

describe('TST-WAL-005: a load that converted into the other purse (T-0521)', () => {
  const ils = async (partyId: string) => (await app.services.accounts.purses(partyId)).find((p) => p.currency === 'ILS')!;
  const loadIntoIls = (m: Member, key: string) => runLoad(app.services.loads, { payerPartyId: m.partyId, memberPartyId: m.partyId, method: 'card', amount: money(10_000n, 'USD'), paymentMethodId: 'pm_ok', purse: 'ILS' }, key, NOW);
  const postings = async (journalId: string) =>
    (await db.query<{ type: string; currency: string; amount_minor: string }>(`select a.type::text, p.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by p.amount_minor desc`, [journalId])).rows;

  it('refunds what is left to the card in dollars at the load\'s own rate, markup included, through fx_position, and closes', async () => {
    await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, NOW);
    const m = await register('+12125550301');
    const l = await loadIntoIls(m, 'load-ils-close-1');
    // $100 at 3.70 less the default 75 bps credits ₪367.22 (T-0519).
    expect((await ils(m.partyId)).available.minor).toBe(36_722n);

    const view = (await close(m, 'closure-ils-1')).body as ClosureView;
    expect(view).toMatchObject({ state: 'closed', refunds: [{ amount: { minor: '36722', currency: 'ILS' }, state: 'settled' }] });
    const refund = (await app.services.transfers.byKey(refundKey(m.partyId, l.transfer.id)))!;
    expect(refund).toMatchObject({ kind: 'refund', state: 'settled', amount: money(36_722n, 'ILS'), conversion: { received: money(10_000n, 'USD') } });
    expect(await postings(refund.journalId!)).toEqual([
      { type: 'wallet', currency: 'ILS', amount_minor: '36722' },
      { type: 'fx_position', currency: 'USD', amount_minor: '10000' },
      { type: 'fee_income', currency: 'ILS', amount_minor: '278' },
      { type: 'partner_settlement', currency: 'USD', amount_minor: '-10000' },
      { type: 'fx_position', currency: 'ILS', amount_minor: '-37000' },
    ]);
    // The club's position from the load and its refund nets to zero in both currencies.
    const net = await db.query<{ currency: string; total: string }>(
      `select p.currency::text, sum(p.amount_minor)::text as total from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id
        where a.type in ('fx_position', 'fee_income') and j.transfer_id in ($1, $2) group by p.currency order by 1`,
      [l.transfer.id, refund.id],
    );
    expect(net.rows).toEqual([{ currency: 'ILS', total: '0' }, { currency: 'USD', total: '0' }]);
    const vendorRefund = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'refund' and entity_id = $1`, [refund.id])).rows[0]!.external_id;
    expect(await host.simulators.funding.getRefund(vendorRefund)).toMatchObject({ amount: money(10_000n, 'USD'), status: 'succeeded' });
    expect((await ils(m.partyId)).available.minor).toBe(0n);
  });

  it('with half of it spent, the card gets half of what it paid: ₪183.61 back to $50.00', async () => {
    const m = await register('+12125550302');
    const l = await loadIntoIls(m, 'load-ils-close-2');
    await bump((await ils(m.partyId)).id, 18_361n); // a card spend of ₪183.61
    expect((await ils(m.partyId)).available.minor).toBe(18_361n);
    expect((await close(m, 'closure-ils-2')).body).toMatchObject({ state: 'closed', refunds: [{ amount: { minor: '18361', currency: 'ILS' }, state: 'settled' }] });
    const refund = (await app.services.transfers.byKey(refundKey(m.partyId, l.transfer.id)))!;
    expect(refund.conversion).toMatchObject({ received: money(5_000n, 'USD'), markupBps: 0n });
    // Half the load's ₪2.78 markup comes back with half of what it paid.
    expect(await postings(refund.journalId!)).toEqual([
      { type: 'wallet', currency: 'ILS', amount_minor: '18361' },
      { type: 'fx_position', currency: 'USD', amount_minor: '5000' },
      { type: 'fee_income', currency: 'ILS', amount_minor: '139' },
      { type: 'partner_settlement', currency: 'USD', amount_minor: '-5000' },
      { type: 'fx_position', currency: 'ILS', amount_minor: '-18500' },
    ]);
  });
});

// Closure (T-0504, REQ-WAL-005) end to end over the funding simulator. TST-WAL-005: closing with $30
// initiates a refund to the funder's source through FundingPort.refund and the close completes only
// after the refund journal posts; a zero balance closes at once. Also: holds and an overdrawn purse
// block; a refused refund blocks with the reason; a pending refund closes on the next read once the
// vendor confirms; money with no load behind it waits on a payout; a closed account no longer signs in.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, Secret, toWire, uuidv7 } from '@kesher/domain';
import { FederatedIdPError, FundingError, fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { createPiiCipher } from '../crypto/pii.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { refundKey, refundSettleKey, type ClosureView } from './closure.ts';
import { refOf } from '../ops/external-ref.ts';
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
  app = createApp({ db, registry: host.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true }), pii: createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) }) });
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

  it('refunds what is left to the card in dollars at the load\'s club rate; the club keeps the markup (ADR-015)', async () => {
    await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, NOW);
    const m = await register('+12125550301');
    const l = await loadIntoIls(m, 'load-ils-close-1');
    // $100 at 3.70 less the default 75 bps credits ₪367.22 (T-0519).
    expect((await ils(m.partyId)).available.minor).toBe(36_722n);

    const view = (await close(m, 'closure-ils-1')).body as ClosureView;
    expect(view).toMatchObject({ state: 'closed', refunds: [{ amount: { minor: '36722', currency: 'ILS' }, state: 'settled' }] });
    const refund = (await app.services.transfers.byKey(refundKey(m.partyId, l.transfer.id)))!;
    // ₪367.22 back at 3.70 is $99.2486: rounded down, $99.24. The $100 paid less the refund is the club's.
    expect(refund).toMatchObject({ kind: 'refund', state: 'settled', amount: money(36_722n, 'ILS'), conversion: { received: money(9_924n, 'USD'), markupBps: 0n } });
    expect(await postings(refund.journalId!)).toEqual([
      { type: 'wallet', currency: 'ILS', amount_minor: '36722' },
      { type: 'fx_position', currency: 'USD', amount_minor: '9924' },
      { type: 'partner_settlement', currency: 'USD', amount_minor: '-9924' },
      { type: 'fx_position', currency: 'ILS', amount_minor: '-36722' },
    ]);
    // Fee income keeps the load's ₪2.78 markup, and the club's FX position holds the shekels that earned it:
    // long ₪2.78, short the $0.76 that bought them at the club rate.
    const net = await db.query<{ type: string; currency: string; total: string }>(
      `select a.type::text, p.currency::text, sum(p.amount_minor)::text as total from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id
        where a.type in ('fx_position', 'fee_income', 'partner_settlement') and j.transfer_id in ($1, $2) group by a.type, p.currency order by 1, 2`,
      [l.transfer.id, refund.id],
    );
    expect(net.rows).toEqual([
      { type: 'fee_income', currency: 'ILS', total: '-278' },
      { type: 'fx_position', currency: 'ILS', total: '278' },
      { type: 'fx_position', currency: 'USD', total: '-76' },
      { type: 'partner_settlement', currency: 'USD', total: '76' },
    ]);
    const vendorRefund = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'refund' and entity_id = $1`, [refund.id])).rows[0]!.external_id;
    expect(await host.simulators.funding.getRefund(vendorRefund)).toMatchObject({ amount: money(9_924n, 'USD'), status: 'succeeded' });
    expect((await ils(m.partyId)).available.minor).toBe(0n);
  });

  it('with half of it spent, what is left goes back at the club rate: ₪183.61 back to $49.62', async () => {
    const m = await register('+12125550302');
    const l = await loadIntoIls(m, 'load-ils-close-2');
    await bump((await ils(m.partyId)).id, 18_361n); // a card spend of ₪183.61
    expect((await ils(m.partyId)).available.minor).toBe(18_361n);
    expect((await close(m, 'closure-ils-2')).body).toMatchObject({ state: 'closed', refunds: [{ amount: { minor: '18361', currency: 'ILS' }, state: 'settled' }] });
    const refund = (await app.services.transfers.byKey(refundKey(m.partyId, l.transfer.id)))!;
    // ₪183.61 at 3.70 is $49.6243, rounded down; no markup leg, so fee income is untouched.
    expect(refund.conversion).toMatchObject({ received: money(4_962n, 'USD'), markupBps: 0n });
    expect(await postings(refund.journalId!)).toEqual([
      { type: 'wallet', currency: 'ILS', amount_minor: '18361' },
      { type: 'fx_position', currency: 'USD', amount_minor: '4962' },
      { type: 'partner_settlement', currency: 'USD', amount_minor: '-4962' },
      { type: 'fx_position', currency: 'ILS', amount_minor: '-18361' },
    ]);
  });
});

// T-0692 (REQ-AUTH-005): closing an Apple-linked account revokes the Apple refresh token.
describe('T-0692: closing revokes the Apple token', () => {
  const TOKEN = 'r.apple-refresh-token-secret-0123456789';
  const revokeCalls = () => host.simulators['federated-idp'].revoked;
  const tokenRows = async (partyId: string) => ((await app.services.socialLinks.takeForRevoke(partyId, 'apple')) === undefined ? 0 : 1);
  const cases = async (partyId: string) => (await db.query<{ kind: string; payload: unknown; severity: string }>(`select kind, payload, severity from ops.case where dedupe_key = $1`, [`apple-revoke:${partyId}`])).rows;
  const linkApple = (partyId: string, withToken = true) => app.services.socialLinks.link(partyId, 'apple', { subject: `apple-${partyId}`, ...(withToken ? { refreshToken: TOKEN } : {}) });

  it('revokes once with the unsealed token under closure:{partyId}:apple-revoke, then erases the row; closing twice revokes once', async () => {
    const m = await register('+12125550401');
    await linkApple(m.partyId);
    expect(await tokenRows(m.partyId)).toBe(1);
    const before = revokeCalls().length;
    const spy = vi.spyOn(host.simulators['federated-idp'], 'revoke');
    expect((await close(m)).body).toMatchObject({ state: 'closed' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('apple', TOKEN, `closure:${m.partyId}:apple-revoke`);
    expect(revokeCalls().slice(before)).toEqual([{ provider: 'apple', refreshToken: TOKEN }]);
    expect(await tokenRows(m.partyId)).toBe(0);
    expect(await cases(m.partyId)).toEqual([]);
    expect((await close(m)).body).toMatchObject({ state: 'closed' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a Google link, a passkey only, and an Apple link without a stored token trigger no revoke', async () => {
    const g = await register('+12125550402');
    await app.services.socialLinks.link(g.partyId, 'google', { subject: `google-${g.partyId}`, refreshToken: TOKEN });
    const p = await register('+12125550403');
    const a = await register('+12125550404');
    await linkApple(a.partyId, false);
    const spy = vi.spyOn(host.simulators['federated-idp'], 'revoke');
    for (const m of [g, p, a]) expect((await close(m, `closure-${m.partyId}`)).body).toMatchObject({ state: 'closed' });
    expect(spy).not.toHaveBeenCalled();
    expect(await cases(a.partyId)).toEqual([]);
    spy.mockRestore();
  });

  it('a revoke failure does not block the closure: one case, no token in it, and the token is erased', async () => {
    const m = await register('+12125550405');
    await linkApple(m.partyId);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const spy = vi.spyOn(host.simulators['federated-idp'], 'revoke').mockRejectedValue(new FederatedIdPError('PROVIDER_UNAVAILABLE', `down, token ${TOKEN}`));
    const r = await close(m);
    expect(r.body).toMatchObject({ state: 'closed' });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(await tokenRows(m.partyId)).toBe(0);
    const rows = await cases(m.partyId);
    expect(rows).toEqual([{ kind: 'apple_revoke_failed', severity: 'high', payload: { partyId: m.partyId, provider: 'apple', failure: 'PROVIDER_UNAVAILABLE' } }]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    // A second close finds no token and opens no second case.
    await close(m);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await cases(m.partyId)).toHaveLength(1);
    for (const l of logs) {
      expect(JSON.stringify(l.mock.calls)).not.toContain(TOKEN);
      l.mockRestore();
    }
    spy.mockRestore();
  });

  it('a refund that fails leaves the account open and the Apple token untouched', async () => {
    const m = await register('+12125550406');
    await linkApple(m.partyId);
    await load(m, 1_500n, 'pm_norefund');
    const spy = vi.spyOn(host.simulators['federated-idp'], 'revoke');
    expect((await close(m, 'closure-norefund')).body).not.toMatchObject({ state: 'closed' });
    expect(spy).not.toHaveBeenCalled();
    expect(await tokenRows(m.partyId)).toBe(1);
    spy.mockRestore();
  });

  it('a crash after the account closed but before the revoke is mended by closing again', async () => {
    const m = await register('+12125550407');
    await linkApple(m.partyId);
    await app.services.identity.setUserStatus(m.partyId, 'closed'); // the state a crash leaves behind
    const spy = vi.spyOn(host.simulators['federated-idp'], 'revoke');
    await app.services.closure.close(m.partyId, NOW);
    expect(spy).toHaveBeenCalledWith('apple', TOKEN, `closure:${m.partyId}:apple-revoke`);
    expect(await tokenRows(m.partyId)).toBe(0);
    spy.mockRestore();
  });

  it('a crash between the revoke and the erase ends with no token after a retry, the revoke replayed under the same key', async () => {
    const m = await register('+12125550408');
    const before = revokeCalls().filter((c) => c.refreshToken === TOKEN).length;
    await linkApple(m.partyId);
    const erase = vi.spyOn(app.services.socialLinks, 'eraseToken').mockRejectedValueOnce(new Error('connection lost'));
    const spy = vi.spyOn(host.simulators['federated-idp'], 'revoke');
    await expect(app.services.closure.close(m.partyId, NOW)).rejects.toThrow('connection lost');
    expect(await tokenRows(m.partyId)).toBe(1);
    expect((await app.services.identity.findUser(m.partyId))!.status).toBe('closed');
    await app.services.closure.close(m.partyId, NOW);
    expect(await tokenRows(m.partyId)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new Set(spy.mock.calls.map((c) => c[2]))).toEqual(new Set([`closure:${m.partyId}:apple-revoke`]));
    // The adapter's idempotency store answered the second call from the first: one revoke reached the IdP.
    expect(revokeCalls().filter((c) => c.refreshToken === TOKEN && c.provider === 'apple').length).toBe(before + 1);
    erase.mockRestore();
    spy.mockRestore();
  });
});

// T-0778: status resolves the pending refunds' vendor ids with one external_ref query, and nothing else changes.
describe('T-0778: closure status reads the pending refunds\' vendor ids in one query', () => {
  type Fate = 'pending' | 'settle' | 'fail' | 'noref';
  interface Spec {
    amounts: bigint[];
    fates: Fate[];
    /** Index of the load whose getRefund throws PROVIDER_UNAVAILABLE. */
    throwAt?: number | undefined;
  }
  interface Setup {
    m: Member;
    loadIds: string[];
    vendorIds: string[];
    vendorLoadIds: string[];
  }
  let phoneSeq = 0;
  const nextPhone = () => `+1212555${String(9000 + phoneSeq++)}`;
  const service = () => app.services.closure;

  /** A member with one pm_slowrefund load per amount, closed once so every load has a pending refund; then each refund meets its fate. */
  async function setup(spec: Spec): Promise<Setup> {
    const m = await register(nextPhone());
    const loadIds: string[] = [];
    const vendorLoadIds: string[] = [];
    for (const [i, amount] of spec.amounts.entries()) {
      const l = await load(m, amount, 'pm_slowrefund', `t0778-${m.partyId}-${i}`);
      loadIds.push(l.transfer.id);
      vendorLoadIds.push((await app.services.loads.vendorLoadOf(l.transfer.id))!);
    }
    const vendorIds: string[] = [];
    if (spec.amounts.length > 0) {
      expect((await service().close(m.partyId, NOW)).state).toBe('refunding');
      for (const [i, loadId] of loadIds.entries()) {
        const t = (await app.services.transfers.byKey(refundKey(m.partyId, loadId)))!;
        // The refunds were created at one clock reading, so their order is a tie on id; pin it to newest load first.
        await db.query(`update ops.transfer set created_at = $2::timestamptz where id = $1`, [t.id, new Date(NOW.getTime() + (loadIds.length - 1 - i) * 1_000).toISOString()]);
        const vendorId = (await refOf(db, 'refund', t.id, 'simulator'))!;
        vendorIds.push(vendorId);
        const fate = spec.fates[i]!;
        if (fate === 'settle') host.simulators.funding.settleRefund(vendorId);
        if (fate === 'fail') host.simulators.funding.settleRefund(vendorId, 'failed');
        if (fate === 'noref') await db.query(`delete from ops.external_ref where entity_type = 'refund' and entity_id = $1`, [t.id]);
      }
    }
    return { m, loadIds, vendorIds, vendorLoadIds };
  }

  /** The pre-change body of ClosureService.status, verbatim but for the ref lookup going through refOf. */
  async function legacyStatus(partyId: string): Promise<ClosureView> {
    const s = service() as unknown as {
      d: { db: typeof db; port: { getRefund(id: string): Promise<unknown> }; provider: string; identity: { findUser(id: string): Promise<{ status: string } | undefined> } };
      refundTransfers(partyId: string): Promise<{ id: string; state: string }[]>;
      applyRefund(t: unknown, refund: unknown, now: Date): Promise<unknown>;
      settle(partyId: string, now: Date): Promise<ClosureView>;
      view(partyId: string, state: string, now: Date): Promise<ClosureView>;
    };
    const user = await s.d.identity.findUser(partyId);
    if (!user) throw new Error('NOT_FOUND');
    if (user.status === 'closed') return s.view(partyId, 'closed', NOW);
    const pending = (await s.refundTransfers(partyId)).filter((t) => t.state === 'submitted');
    if (pending.length === 0) return s.view(partyId, 'open', NOW);
    for (const t of pending) {
      const refundId = await refOf(s.d.db, 'refund', t.id, s.d.provider);
      if (refundId) await s.applyRefund(t, await s.d.port.getRefund(refundId), NOW);
    }
    return s.settle(partyId, NOW);
  }

  /** Runs status (new or the legacy body) and returns everything observable about the outcome, ids replaced by their position. */
  async function observe(which: 'new' | 'legacy', su: Setup, throwAt?: number | undefined) {
    const { m, loadIds, vendorIds, vendorLoadIds } = su;
    const funding = host.simulators.funding;
    const original = funding.getRefund.bind(funding);
    const calls: string[] = [];
    const spy = vi.spyOn(funding, 'getRefund').mockImplementation(async (id: string) => {
      calls.push(id);
      if (throwAt !== undefined && id === vendorIds[throwAt]) throw new FundingError('PROVIDER_UNAVAILABLE', 'vendor down');
      return original(id);
    });
    let outcome: { view: ClosureView } | { error: string };
    try {
      outcome = { view: which === 'new' ? await service().status(m.partyId, NOW) : await legacyStatus(m.partyId) };
    } catch (e) {
      outcome = { error: `${(e as { code?: string }).code ?? ''}|${(e as Error).message}` };
    } finally {
      spy.mockRestore();
    }
    const transfers = await Promise.all(loadIds.map(async (id) => (await app.services.transfers.byKey(refundKey(m.partyId, id)))!));
    const names = new Map<string, string>([[m.partyId, 'P']]);
    loadIds.forEach((id, i) => names.set(id, `L${i}`));
    transfers.forEach((t, i) => names.set(t.id, `R${i}`));
    vendorIds.forEach((id, i) => names.set(id, `V${i}`));
    vendorLoadIds.forEach((id, i) => names.set(id, `VL${i}`));
    const norm = (v: unknown) => {
      let j = JSON.stringify(v);
      for (const [from, to] of names) j = j.split(from).join(to);
      return JSON.parse(j) as unknown;
    };
    const ids = transfers.map((t) => t.id);
    const events = (await db.query<{ transfer_id: string; from_state: string | null; to_state: string; reason: string | null }>(`select transfer_id, from_state, to_state, reason from ops.transfer_event where transfer_id = any($1::uuid[]) order by id`, [ids])).rows;
    const journalRows = (await db.query<{ id: string; idempotency_key: string; kind: string; transfer_id: string; effective_at: string; metadata: unknown }>(`select j.id, j.idempotency_key, j.kind, j.transfer_id, j.effective_at::text, j.metadata from ledger.journal j where j.kind = 'refund' and j.transfer_id = any($1::uuid[]) order by (select min(p.id) from ledger.posting p where p.journal_id = j.id)`, [ids])).rows;
    const journals = [];
    for (const j of journalRows) {
      const postings = (await db.query<{ type: string; currency: string; amount_minor: string }>(`select a.type::text, p.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by p.id`, [j.id])).rows;
      journals.push({ key: j.idempotency_key, kind: j.kind, transfer: j.transfer_id, effectiveAt: j.effective_at, metadata: j.metadata, postings });
    }
    const refs = (await db.query<{ entity_id: string; external_id: string }>(`select entity_id, external_id from ops.external_ref where entity_type = 'refund' and entity_id = any($1::uuid[]) order by external_id`, [ids])).rows;
    const audits = (await db.query<{ action: string; payload: unknown }>(`select action, payload from audit.entry where subject = $1 order by id`, [m.partyId])).rows;
    return norm({
      outcome,
      calls,
      transfers: transfers.map((t) => ({ state: t.state, failureCode: t.failureCode ?? null, amount: toWire(t.amount), settled: t.journalId !== undefined })),
      events,
      journals,
      refs,
      audits: audits.map((a) => ({ action: a.action, payload: a.payload })),
      userStatus: (await app.services.identity.findUser(m.partyId))!.status,
      purses: (await app.services.accounts.purses(m.partyId)).map((p) => ({ c: p.currency, a: p.available.minor.toString(), h: p.holds.minor.toString() })),
    }) as { outcome: { view?: ClosureView; error?: string }; calls: string[]; journals: { key: string }[]; transfers: { state: string }[]; events: unknown[]; audits: unknown[]; userStatus: string; refs: unknown[]; purses: unknown[] };
  }

  /** Counts statements that read ops.external_ref while `fn` runs. */
  async function refQueries(fn: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(db, 'query');
    try {
      await fn();
      return spy.mock.calls.filter((c) => /external_ref/.test(String(c[0]))).length;
    } finally {
      spy.mockRestore();
    }
  }

  // ---- characterization: green before and after ----

  it('three submitted refunds, one without a ref: the other two are asked at the vendor and applied in refund order; the closure keeps refunding', async () => {
    const su = await setup({ amounts: [1_100n, 2_200n, 3_300n], fates: ['settle', 'noref', 'settle'] });
    const o = await observe('new', su);
    expect(o.outcome.view).toMatchObject({ state: 'refunding' });
    // Refunds were created newest load first (L2, L1, L0); the vendor is asked in that order and the one without a ref is skipped.
    expect(o.calls).toEqual(['V2', 'V0']);
    expect(o.transfers.map((t) => t.state)).toEqual(['settled', 'submitted', 'settled']);
    expect(o.journals.map((j) => j.key)).toEqual([`${refundSettleKey(`closure:P:L2`)}`, `${refundSettleKey(`closure:P:L0`)}`]);
    expect(o.userStatus).toBe('active');
    // The same call again is a replay: nothing new is posted, the same two are asked again.
    const again = await observe('new', su);
    expect(again.journals).toEqual(o.journals);
    expect(again.events).toEqual(o.events);
    expect(again.outcome).toEqual(o.outcome);
    // The two settled refunds are not asked about again, and the one without a ref never is.
    expect(again.calls).toEqual([]);
  });

  it('only a refund link under this provider and entity type counts: a link elsewhere is a refund without a ref', async () => {
    const su = await setup({ amounts: [1_000n, 2_000n], fates: ['settle', 'settle'] });
    const t0 = (await app.services.transfers.byKey(refundKey(su.m.partyId, su.loadIds[0]!)))!;
    const t1 = (await app.services.transfers.byKey(refundKey(su.m.partyId, su.loadIds[1]!)))!;
    // L0's refund keeps only a link under another provider; L1's keeps only a link of another entity type.
    await db.query(`update ops.external_ref set provider = 'other-vendor' where entity_type = 'refund' and entity_id = $1`, [t0.id]);
    await db.query(`update ops.external_ref set entity_type = 'transfer' where entity_type = 'refund' and entity_id = $1`, [t1.id]);
    const o = await observe('new', su);
    expect(o.calls).toEqual([]);
    expect(o.transfers.map((t) => t.state)).toEqual(['submitted', 'submitted']);
    expect(o.outcome.view).toMatchObject({ state: 'refunding' });
  });

  it('every refund confirmed: the account closes once, with one audit entry', async () => {
    const su = await setup({ amounts: [900n, 1_800n], fates: ['settle', 'settle'] });
    const o = await observe('new', su);
    expect(o.outcome.view).toMatchObject({ state: 'closed', refunds: [{ state: 'settled' }, { state: 'settled' }] });
    expect(o.userStatus).toBe('closed');
    expect(o.audits.filter((a) => (a as { action: string }).action === 'account.closed')).toHaveLength(1);
  });

  it('one refund the vendor refuses fails its transfer and blocks the closure; a pending one stays submitted', async () => {
    const su = await setup({ amounts: [700n, 1_400n, 2_100n], fates: ['fail', 'pending', 'settle'] });
    const o = await observe('new', su);
    expect(o.transfers.map((t) => t.state)).toEqual(['failed', 'submitted', 'settled']);
    expect(o.outcome.view).toMatchObject({ state: 'refunding' });
    expect(o.calls).toEqual(['V2', 'V1', 'V0']);
  });

  it('a vendor error on the second refund propagates after the first was applied; the third is not asked; a retry finishes', async () => {
    const su = await setup({ amounts: [600n, 1_200n, 1_800n], fates: ['settle', 'settle', 'settle'] });
    const o = await observe('new', su, 1);
    expect(o.outcome.error).toBe('PROVIDER_UNAVAILABLE|vendor down');
    expect(o.calls).toEqual(['V2', 'V1']);
    expect(o.transfers.map((t) => t.state)).toEqual(['submitted', 'submitted', 'settled']);
    const retry = await observe('new', su);
    expect(retry.outcome.view).toMatchObject({ state: 'closed' });
    expect(retry.transfers.map((t) => t.state)).toEqual(['settled', 'settled', 'settled']);
    expect(retry.journals).toHaveLength(3);
  });

  it('one pending refund, and none at all, report the same as before', async () => {
    const one = await setup({ amounts: [1_000n], fates: ['settle'] });
    expect((await observe('new', one)).outcome.view).toMatchObject({ state: 'closed', refunds: [{ state: 'settled' }] });
    const none = await setup({ amounts: [], fates: [] });
    const o = await observe('new', none, undefined);
    expect(o.outcome.view).toMatchObject({ state: 'open', refunds: [] });
    expect(o.calls).toEqual([]);
  });

  // ---- statement count ----

  it('status with three submitted refunds, one without a ref, issues one external_ref query', async () => {
    const su = await setup({ amounts: [1_100n, 2_200n, 3_300n], fates: ['settle', 'noref', 'settle'] });
    expect(await refQueries(() => service().status(su.m.partyId, NOW))).toBe(1);
  });

  it('one submitted refund: one external_ref query', async () => {
    const su = await setup({ amounts: [1_500n], fates: ['pending'] });
    expect(await refQueries(() => service().status(su.m.partyId, NOW))).toBe(1);
  });

  it('a closed account and an account with no pending refunds issue no external_ref query', async () => {
    const none = await setup({ amounts: [], fates: [] });
    expect(await refQueries(() => service().status(none.m.partyId, NOW))).toBe(0);
    const done = await setup({ amounts: [800n], fates: ['settle'] });
    await service().status(done.m.partyId, NOW);
    expect((await app.services.identity.findUser(done.m.partyId))!.status).toBe('closed');
    expect(await refQueries(() => service().status(done.m.partyId, NOW))).toBe(0);
    // The vendor refused the only refund: it failed, the account stays open, and nothing is pending any more.
    const blocked = await setup({ amounts: [800n], fates: ['fail'] });
    await service().status(blocked.m.partyId, NOW);
    expect(await refQueries(() => service().status(blocked.m.partyId, NOW))).toBe(0);
  });

  // ---- differential: the new status against the pre-change body, over random scenarios ----

  it('matches the pre-change status byte for byte over random scenarios (views, calls, journals, events, refs, errors)', { timeout: 120_000 }, async () => {
    // mulberry32: a small seeded generator, so a failing scenario replays.
    let seed = 0x778;
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) % n);
    };
    const fateOf = (): Fate => (['pending', 'settle', 'fail', 'noref'] as const)[rnd(4)]!;
    const seen = { empty: 0, closed: 0, refunding: 0, blocked: 0, error: 0, settledThenOpen: 0, noref: 0, many: 0 };
    for (let run = 0; run < 24; run++) {
      const n = run === 0 ? 0 : 1 + rnd(5);
      const amounts = Array.from({ length: n }, () => BigInt(500 + rnd(9_000)));
      const fates = Array.from({ length: n }, fateOf);
      const throwAt = n > 0 && rnd(3) === 0 ? rnd(n) : undefined;
      const spec: Spec = { amounts, fates, throwAt };
      const a = await setup(spec);
      const b = await setup(spec);
      const viaNew = await observe('new', a, throwAt);
      const viaOld = await observe('legacy', b, throwAt);
      expect(viaNew, JSON.stringify({ run, amounts: amounts.map(String), fates, throwAt })).toEqual(viaOld);
      // And once more (a replay, or the retry after an error): still identical, down to the vendor calls it makes.
      const replayNew = await observe('new', a);
      expect(replayNew, JSON.stringify({ run, replay: true })).toEqual(await observe('legacy', b));
      if (n === 0) seen.empty++;
      if (n >= 3) seen.many++;
      if (viaNew.outcome.error) seen.error++;
      else seen[viaNew.outcome.view!.state as 'closed' | 'refunding' | 'blocked']++;
      if (fates.includes('noref')) seen.noref++;
      if (viaNew.transfers.some((t) => t.state === 'settled') && viaNew.transfers.some((t) => t.state === 'submitted')) seen.settledThenOpen++;
    }
    // The generator must reach every branch, or the comparison proves little.
    expect(seen.empty).toBeGreaterThan(0);
    expect(seen.closed).toBeGreaterThan(0);
    expect(seen.refunding).toBeGreaterThan(0);
    expect(seen.blocked + seen.error).toBeGreaterThan(0);
    expect(seen.error).toBeGreaterThan(0);
    expect(seen.noref).toBeGreaterThan(0);
    expect(seen.settledThenOpen).toBeGreaterThan(0);
    expect(seen.many).toBeGreaterThan(0);
  });
});

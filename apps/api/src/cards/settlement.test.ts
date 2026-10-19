// TST-CRD-003, settlement (T-0410): the processor's clearing for an approved authorisation ends its hold
// once, however often it arrives: pending gives back what was held, partner_settlement takes what was
// claimed, and the difference comes from or goes back to the purse that paid. A converted hold (T-0409)
// clears in the authorisation currency at the hold's own rate. A hold nobody clears within 7 days is
// released to the purse that paid, markup and all: the member pays the conversion only on what was spent
// (ADR-016, T-0411).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Currency } from '@kesher/domain';
import { type CardIssuingPort, type CardIssuingSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { holdKey } from './jit.ts';
import { endKey, HOLD_RELEASE_MS, lateKey } from './settlement.ts';

let db: TestDatabase;
let app: App;
let sim: CardIssuingSimulator;
const NOW = new Date('2026-11-01T09:00:00Z');
let now = NOW;
const MERCHANT = { name: 'Super-Pharm', mcc: '5912', country: 'IL' };

interface Member {
  card: string;
  wallet: Record<Currency, string>;
  pending: Record<Currency, string>;
}
let noa: Member;
let ari: Member;

/** What the member sees in an account (wallet and pending are credit-normal). */
const held = async (account: string, currency: Currency) => -(await app.services.ledger.balance(account, currency));
const partner = async (currency: Currency) => app.services.ledger.balance(await app.services.accounts.systemAccount('partner_settlement', currency), currency);
const feeIncome = async (currency: Currency) => -(await app.services.ledger.balance(await app.services.accounts.systemAccount('fee_income', currency), currency));

async function member(name: string): Promise<Member> {
  const party = uuidv7(NOW);
  const s = await app.services.kyc.start(party, 'T2', `kyc-${name}`, NOW);
  await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-${name}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
  const card = (await db.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1`, [party])).rows[0]!.processor_card_id;
  const acct = (type: 'wallet' | 'pending', c: Currency) => app.services.accounts.memberAccount(party, type, c);
  return { card, wallet: { ILS: await acct('wallet', 'ILS'), USD: await acct('wallet', 'USD') }, pending: { ILS: await acct('pending', 'ILS'), USD: await acct('pending', 'USD') } };
}

async function load(account: string, currency: Currency, minor: bigint, key: string) {
  const p = await app.services.accounts.systemAccount('partner_settlement', currency);
  await app.services.ledger.post({ idempotencyKey: key, kind: 'load', postings: [{ accountId: p, currency, amountMinor: minor }, { accountId: account, currency, amountMinor: -minor }] });
}

async function authorize(m: Member, minor: bigint, currency: Currency): Promise<string> {
  const signed = sim.authorize(m.card, { amount: { minor, currency }, merchant: MERCHANT, channel: 'pos' });
  const r = await dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: signed.headers, rawBody: signed.rawBody, now });
  expect(r.body).toMatchObject({ result: 'APPROVED' });
  return (JSON.parse(signed.rawBody) as { authId: string }).authId;
}

const clear = (authId: string, minor: bigint, currency: Currency, eventId?: string) => {
  const signed = sim.clear(authId, { minor, currency }, eventId);
  return dispatch(app, { method: 'POST', url: '/v1/hooks/card-issuing', headers: signed.headers, rawBody: signed.rawBody, now });
};

const journals = async (authId: string) =>
  (await db.query<{ idempotency_key: string; kind: string }>(`select idempotency_key, kind from ledger.journal where idempotency_key like $1 order by idempotency_key`, [`${holdKey(authId)}%`])).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  sim = host.registry.resolve<CardIssuingPort>('card-issuing', 'IL') as CardIssuingSimulator;
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, flags: new StaticFlags(undefined, { 'card.virtual': true }) });
  noa = await member('noa');
  ari = await member('ari');
  await load(noa.wallet.ILS, 'ILS', 50_000n, 'load:noa');
  await load(ari.wallet.ILS, 'ILS', 50_000n, 'load:ari');
  await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, NOW);
}, 60_000);
afterAll(async () => db.close());

describe('clearing (TST-CRD-003)', () => {
  it('moves the hold pending → partner_settlement once, however often the processor sends it', async () => {
    const wallet = await held(noa.wallet.ILS, 'ILS');
    const owed = await partner('ILS');
    const authId = await authorize(noa, 1_800n, 'ILS');
    expect(await held(noa.pending.ILS, 'ILS')).toBe(1_800n);

    expect(await clear(authId, 1_800n, 'ILS')).toMatchObject({ status: 200, body: { duplicate: false } });
    expect(await clear(authId, 1_800n, 'ILS')).toMatchObject({ status: 200, body: { duplicate: true } });
    // The processor resends under a new event id: the hold already ended, nothing moves.
    expect(await clear(authId, 1_800n, 'ILS', `clr_${authId}_again`)).toMatchObject({ status: 200 });

    expect(await held(noa.pending.ILS, 'ILS')).toBe(0n);
    expect(await held(noa.wallet.ILS, 'ILS')).toBe(wallet - 1_800n);
    expect(await partner('ILS')).toBe(owed - 1_800n);
    expect(await journals(authId)).toEqual([{ idempotency_key: holdKey(authId), kind: 'auth_hold' }, { idempotency_key: endKey(authId), kind: 'card_clearing' }]);
  });

  it('a clearing above the hold draws the difference from the wallet; below it gives the rest back', async () => {
    const wallet = await held(noa.wallet.ILS, 'ILS');
    const tip = await authorize(noa, 1_000n, 'ILS');
    await clear(tip, 1_200n, 'ILS'); // a restaurant tip
    expect(await held(noa.wallet.ILS, 'ILS')).toBe(wallet - 1_200n);

    const fuel = await authorize(noa, 1_000n, 'ILS');
    await clear(fuel, 700n, 'ILS');
    expect(await held(noa.wallet.ILS, 'ILS')).toBe(wallet - 1_900n);
    expect(await held(noa.pending.ILS, 'ILS')).toBe(0n);
  });

  it('a converted hold clears in dollars: more claimed converts with the markup; less costs what the cleared amount costs (T-0411)', async () => {
    const shekels = await held(ari.wallet.ILS, 'ILS');
    const fees = await feeIncome('ILS');
    const owed = await partner('USD');
    const over = await authorize(ari, 5_000n, 'USD'); // $50 × 3.70 = ₪185.00 + ₪1.39 at 75 bps
    expect(await held(ari.wallet.ILS, 'ILS')).toBe(shekels - 18_639n);
    await clear(over, 5_200n, 'USD'); // $2 more: ₪7.40 + ₪0.06 (5.55 rounds up)
    expect(await held(ari.wallet.ILS, 'ILS')).toBe(shekels - 18_639n - 746n);
    expect(await feeIncome('ILS')).toBe(fees + 139n + 6n);
    expect(await held(ari.pending.USD, 'USD')).toBe(0n);
    expect(await partner('USD')).toBe(owed - 5_200n);

    const under = await authorize(ari, 5_000n, 'USD');
    // $45 costs ₪166.50 + ₪1.25 at 75 bps (1.24875 rounds up): of the ₪186.39 held, ₪18.64 goes back, ₪0.14 of it markup.
    await clear(under, 4_500n, 'USD');
    expect(await held(ari.wallet.ILS, 'ILS')).toBe(shekels - 18_639n - 746n - 16_775n); // the $45 cost ₪167.75 in all
    expect(await feeIncome('ILS')).toBe(fees + 139n + 6n + 125n);
    expect(await held(ari.pending.USD, 'USD')).toBe(0n);
  });

  it('a clearing in another currency, or for an authorisation never held, ends nothing and stays pending for replay', async () => {
    const authId = await authorize(noa, 300n, 'ILS');
    await clear(authId, 300n, 'USD');
    await clear('auth_unknown', 300n, 'ILS');
    expect(await journals(authId)).toEqual([{ idempotency_key: holdKey(authId), kind: 'auth_hold' }]);
    const failed = await db.query<{ event_id: string; processed_at: Date | null; error: string }>(`select event_id, processed_at, error from ops.inbound_event where provider = 'card-issuing' and event_id = any($1::text[]) order by event_id`, [[`clr_${authId}`, 'clr_auth_unknown']]);
    expect(failed.rows).toEqual([
      { event_id: `clr_${authId}`, processed_at: null, error: 'A clearing settles in the authorisation currency' },
      { event_id: 'clr_auth_unknown', processed_at: null, error: 'No hold for authorisation auth_unknown' },
    ]);
    // The processor's corrected event in shekels ends the hold.
    await clear(authId, 300n, 'ILS', `clr_${authId}_ils`);
    expect((await journals(authId)).map((j) => j.kind)).toEqual(['auth_hold', 'card_clearing']);
  });
});

describe('release after 7 days (TST-CRD-003)', () => {
  it('releases an unclaimed hold to the wallet once; a clearing that comes later draws from the wallet', async () => {
    now = NOW;
    const wallet = await held(noa.wallet.ILS, 'ILS');
    const authId = await authorize(noa, 500n, 'ILS');
    // Not yet due a second before 7 days.
    expect((await app.services.settlement.releaseExpired(new Date(NOW.getTime() + HOLD_RELEASE_MS - 1_000))).released).toBe(0);

    now = new Date(NOW.getTime() + HOLD_RELEASE_MS + 60_000);
    const r = await app.services.settlement.releaseExpired(now);
    expect(r).toMatchObject({ released: 1, errors: [] });
    expect(r.oldestOpenMs).toBeLessThan(HOLD_RELEASE_MS);
    expect((await app.services.settlement.releaseExpired(now)).released).toBe(0);
    expect(await held(noa.wallet.ILS, 'ILS')).toBe(wallet);
    expect(await held(noa.pending.ILS, 'ILS')).toBe(0n);

    // Late presentment: the merchant claims after the release; the whole amount comes from the wallet, once.
    await clear(authId, 500n, 'ILS');
    await clear(authId, 500n, 'ILS', `clr_${authId}_again`);
    expect(await held(noa.wallet.ILS, 'ILS')).toBe(wallet - 500n);
    expect(await held(noa.pending.ILS, 'ILS')).toBe(0n);
    expect(await journals(authId)).toEqual([
      { idempotency_key: holdKey(authId), kind: 'auth_hold' },
      { idempotency_key: endKey(authId), kind: 'auth_release' },
      { idempotency_key: lateKey(authId), kind: 'card_clearing' },
    ]);
  });

  it('a cleared hold is never released', async () => {
    now = NOW;
    const authId = await authorize(noa, 400n, 'ILS');
    await clear(authId, 400n, 'ILS');
    now = new Date(NOW.getTime() + HOLD_RELEASE_MS + 120_000);
    await app.services.settlement.releaseExpired(now);
    expect(await journals(authId)).toEqual([{ idempotency_key: holdKey(authId), kind: 'auth_hold' }, { idempotency_key: endKey(authId), kind: 'card_clearing' }]);
  });

  it('a converted hold released unspent goes back to the purse that paid whole, markup included (T-0411)', async () => {
    now = NOW;
    const shekels = await held(ari.wallet.ILS, 'ILS');
    const fees = await feeIncome('ILS');
    await authorize(ari, 1_000n, 'USD'); // $10 × 3.70 = ₪37.00 + ₪0.28
    expect(await held(ari.wallet.ILS, 'ILS')).toBe(shekels - 3_728n);
    now = new Date(NOW.getTime() + HOLD_RELEASE_MS + 180_000);
    expect((await app.services.settlement.releaseExpired(now)).released).toBe(1);
    expect(await held(ari.wallet.ILS, 'ILS')).toBe(shekels);
    expect(await held(ari.pending.USD, 'USD')).toBe(0n);
    expect(await feeIncome('ILS')).toBe(fees);
  });
});

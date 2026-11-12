// CrowdedFunding (T-0700, REQ-WAL-002, REQ-WAL-003, ADR-018 A3/A4/A8): the hosted-load method of FundingPort over Crowded's
// collections and intents, against FakeCrowded. Two parts:
// - the port's `fundingContract` with `hosted: true`. The adapter is hosted only, so the card, Apple Pay, Google Pay, ACH,
//   webhook and refund cases of that suite are served by the port's own simulator behind a small router (`HostedPlusSim`);
//   every hosted case and every `crowded:` load id goes to the Crowded adapter.
// - the Crowded-only block: one collection and one intent per key, the status table, the hold, the fee rule, the redirect
//   allowlist, URL normalisation, `expiresAt` persistence, and no personal data stored or reported.
// All names, emails, mobiles and addresses are made up (example.test, 555 numbers, 203.0.113.0/24 documentation range).
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { money } from '@kesher/domain';
import { addBusinessDays, FundingError, FundingSimulator, isFundingCreditPort, type FundingCreditPort, type FundingPort, type Load } from '@kesher/ports';
import { fundingContract } from '@kesher/ports/contracts';
import { bookWireKey } from './book.ts';
import { CrowdedClient } from './client.ts';
import { FakeCrowded } from './fake-crowded.ts';
import { InMemoryKeyLedger, type KeyLedger } from './institution-banking.ts';
import { CrowdedFunding, type CrowdedFundingOptions } from './funding.ts';
import { CrowdedMemberAccounts } from './member-accounts.ts';
import { CrowdedMirror } from './mirror.ts';

const TOKEN = 'crowded_test_token_not_a_secret';
const BASE = 'https://sandbox.fake.invalid/api/v1';
const MAC_KEY = 'test-only-mac-key-not-a-secret-0123456789';
const IP = '203.0.113.7';

function harness(over: { ledger?: KeyLedger; fake?: FakeCrowded; chapterId?: string; clock?: { t: Date }; opts?: Partial<CrowdedFundingOptions>; wrap?: (f: typeof globalThis.fetch) => typeof globalThis.fetch } = {}) {
  const clock = over.clock ?? { t: new Date('2026-11-03T09:00:00Z') };
  const fake = over.fake ?? new FakeCrowded({ token: TOKEN, pageSize: 2, now: () => clock.t });
  const chapterId = over.chapterId ?? fake.seedChapter();
  const ledger = over.ledger ?? new InMemoryKeyLedger();
  const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: over.wrap ? over.wrap(fake.fetch) : fake.fetch });
  const members = new CrowdedMemberAccounts({ client, chapterId, hmacKey: MAC_KEY, ledger: new InMemoryKeyLedger(), now: () => clock.t });
  const mobiles = new Map<string, string>();
  const mobileOf = (customerId: string): string => {
    if (!mobiles.has(customerId)) mobiles.set(customerId, `+1415555${String(1000 + mobiles.size)}`);
    return mobiles.get(customerId)!;
  };
  /** A customer's contact at the fake, made through the member adapter (the real path to a `c:<id>` ref). */
  const contactOf = async (customerId: string): Promise<string> =>
    (await members.ensureAccount({ partyId: customerId, firstName: 'Payer', lastName: 'Test', email: `${customerId}@example.test`, mobile: mobileOf(customerId) }, `ensure-${customerId}`)).contactRef;
  const adapter = new CrowdedFunding({ client, chapterId, hmacKey: MAC_KEY, ledger, achHoldDays: 3, redirectHosts: ['app.example'], contactOf, now: () => clock.t, ...over.opts });
  return { fake, adapter, chapterId, ledger, clock, client, contactOf, mobileOf };
}
type Harness = ReturnType<typeof harness>;

/** The port's non-hosted methods come from its simulator; hosted loads and `crowded:` ids go to the adapter. */
class HostedPlusSim implements FundingPort {
  readonly sim = new FundingSimulator();
  readonly h: Harness;
  constructor(h: Harness) {
    this.h = h;
  }
  createLoad: FundingPort['createLoad'] = (input, key) => (input.method === 'hosted' ? this.h.adapter.createLoad(input, key) : this.sim.createLoad(input, key));
  getLoad: FundingPort['getLoad'] = (id) => (id.startsWith('crowded:') ? this.h.adapter.getLoad(id) : this.sim.getLoad(id));
  refund: FundingPort['refund'] = (i, k) => this.sim.refund(i, k);
  getRefund: FundingPort['getRefund'] = (id) => this.sim.getRefund(id);
  parseWebhook: FundingPort['parseWebhook'] = (hd, body) => this.sim.parseWebhook(hd, body);
}

fundingContract('crowded hosted (fake) with the simulator for the other methods', () => new HostedPlusSim(harness()), {
  goodPaymentMethod: 'pm_card_ok',
  declinedPaymentMethod: 'pm_declined',
  outagePaymentMethod: 'pm_outage',
  achPaymentMethod: 'pm_bank_ok',
  succeededWebhook: async (port, id) => (port as HostedPlusSim).sim.webhookFor(id, 'succeeded'),
  norefundPaymentMethod: 'pm_norefund',
  hosted: true,
});

const amount = money(10_000n, 'USD');
const hosted = { payerIp: IP, userConsented: true } as const;
const start = (h: Harness, key = 'load-key-0001', over: Record<string, unknown> = {}, customerId = 'c1') =>
  h.adapter.createLoad({ customerId, method: 'hosted', amount, hosted: { ...hosted, ...over } as never }, key);
const intentId = (loadId: string): string => loadId.split(':')[2]!;
/** The fake's controls want `<chapter>:<collection>:<intent>`; the collection is not used to find an intent. */
const ref = (h: Harness, l: Load) => `${h.chapterId}:-:${intentId(l.loadId)}`;
const collectionCalls = (h: Harness) => h.fake.calls.filter((c) => /\/collections/.test(c.path));
const attempt = async <T>(p: Promise<T>): Promise<T | Error> => p.then((v) => v, (e: unknown) => e as Error);

describe('CrowdedFunding hosted loads (T-0700, TST-WAL-002, TST-WAL-003)', () => {
  it('makes one collection titled with the load reference and one intent for the payer, and answers requires_action with the payment page', async () => {
    const h = harness();
    const l = await start(h);
    expect(h.fake.count('collections')).toBe(1);
    expect(h.fake.count('intents')).toBe(1);
    const title = h.fake.names('collections')[0]!;
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title).toContain('load-key-0001');
    expect(title).not.toMatch(/Payer|c1|203|example/);
    const col = h.fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/collections'))!;
    expect((col.body as { data: Record<string, unknown> }).data).toEqual({ title, requestedAmount: Number(amount.minor) });
    const intent = h.fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/intents'))!;
    expect((intent.body as { data: Record<string, unknown> }).data).toMatchObject({ contactId: String(h.fake.contactId(h.mobileOf('c1'))), requestedAmount: Number(amount.minor), payerIp: IP, userConsented: true });
    expect(l).toMatchObject({ method: 'hosted', amount, status: 'requires_action', action: { type: 'payment_page', url: `https://pay.fake.invalid/${intentId(l.loadId)}` } });
    expect(l.loadId).toMatch(new RegExp(`^crowded:${h.chapterId}:[A-Za-z0-9_-]+$`));
    expect(l.clientSecret).toBeUndefined();
  });

  it('the same key twice (also from a second adapter on the same ledger) makes one collection and one intent', async () => {
    const h = harness();
    const a = await start(h);
    const b = await start(h);
    const second = harness({ fake: h.fake, chapterId: h.chapterId, ledger: h.ledger, clock: h.clock });
    const c = await start(second);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(h.fake.count('collections')).toBe(1);
    expect(h.fake.count('intents')).toBe(1);
  });

  it('two calls at once with one key make one collection', async () => {
    const h = harness();
    const [a, b] = await Promise.all([start(h), start(h)]);
    expect(b).toEqual(a);
    expect(h.fake.count('collections')).toBe(1);
  });

  it('refuses a key reused with another input, sending nothing', async () => {
    const h = harness();
    await start(h);
    const before = collectionCalls(h).length;
    for (const input of [{ ...{ customerId: 'c1', method: 'hosted' as const, amount: money(10_001n, 'USD'), hosted } }, { customerId: 'c2', method: 'hosted' as const, amount, hosted }, { customerId: 'c1', method: 'hosted' as const, amount, hosted: { ...hosted, successUrl: 'https://app.example/other' } }]) {
      expect(await attempt(h.adapter.createLoad(input, 'load-key-0001'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(collectionCalls(h).length).toBe(before);
  });

  it('does not reuse a collection with the same title and amount that another key claimed', async () => {
    const h = harness();
    const keyA = `${'k'.repeat(60)}a`;
    const keyB = `${'k'.repeat(60)}b`;
    h.fake.failIntents = 1;
    expect(await attempt(start(h, keyA))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' }); // collection made and claimed by A, no intent
    const b = await start(h, keyB, {}, 'c2');
    expect(h.fake.count('collections')).toBe(2);
    expect(new Set(h.fake.names('collections')).size).toBe(1); // the same (truncated) title twice
    const a = await start(h, keyA); // A's retry finds its own collection
    expect(h.fake.count('collections')).toBe(2);
    expect(h.fake.count('intents')).toBe(2);
    expect(a.loadId).not.toBe(b.loadId);
  });

  it('a Crowded 5xx is PROVIDER_UNAVAILABLE and the key is kept: the retry finds the same collection', async () => {
    const h = harness();
    h.fake.failIntents = 1;
    expect(await attempt(start(h))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.count('collections')).toBe(1);
    expect(h.fake.count('intents')).toBe(0);
    const l = await start(h);
    expect(l.status).toBe('requires_action');
    expect(h.fake.count('collections')).toBe(1);
    expect(h.fake.count('intents')).toBe(1);
  });

  it('an outage before anything is made claims nothing: the same key works afterwards', async () => {
    const h = harness();
    await h.contactOf('c1');
    h.fake.outageRequests = 1;
    expect(await attempt(start(h))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.count('collections')).toBe(0);
    expect((await start(h)).status).toBe('requires_action');
    expect(h.fake.count('collections')).toBe(1);
  });

  describe('getLoad maps the payment statuses', () => {
    const load = async (h: Harness, loadId: string) => h.adapter.getLoad(loadId);

    it('an intent with no payment is requires_action with the page', async () => {
      const h = harness();
      const l = await start(h);
      expect(await load(h, l.loadId)).toEqual(l);
    });

    it('a card Succeeded is succeeded, with the method card and no action', async () => {
      const h = harness();
      const l = await start(h);
      h.fake.payIntent(ref(h, l), 'card');
      const r = await load(h, l.loadId);
      expect(r).toMatchObject({ loadId: l.loadId, status: 'succeeded', method: 'card', amount });
      expect(r.action).toBeUndefined();
      expect(r.holdUntil).toBeUndefined();
    });

    it('a bank transfer Pending and Processing are processing', async () => {
      const h = harness();
      const l = await start(h);
      const p = h.fake.payIntent(ref(h, l), 'ach');
      expect(await load(h, l.loadId)).toMatchObject({ status: 'processing', method: 'ach' });
      h.fake.process(p);
      expect(await load(h, l.loadId)).toMatchObject({ status: 'processing', method: 'ach' });
    });

    it('a bank transfer Succeeded is on_hold until the success instant plus the configured business days', async () => {
      const h = harness({ clock: { t: new Date('2026-11-05T09:30:00Z') } }); // a Thursday: three business days land after the weekend
      const l = await start(h);
      const p = h.fake.payIntent(ref(h, l), 'ach');
      h.fake.settle(p);
      const settledAt = h.clock.t;
      h.clock.t = new Date(settledAt.getTime() + 86_400_000); // reading it later does not move the hold
      const r = await load(h, l.loadId);
      expect(r).toMatchObject({ status: 'on_hold', method: 'ach', amount, holdUntil: addBusinessDays(settledAt, 3).toISOString() });
      expect(r.holdUntil).toBe('2026-11-10T09:30:00.000Z');
    });

    it('the hold days come from the option and a zero hold is the success instant', async () => {
      const h = harness({ opts: { achHoldDays: 0 } });
      const l = await start(h);
      h.fake.settle(h.fake.payIntent(ref(h, l), 'ach'));
      expect((await load(h, l.loadId)).holdUntil).toBe(h.clock.t.toISOString());
    });

    it('Failed and Cancelled are failed', async () => {
      const h = harness();
      const a = await start(h, 'load-key-fail1');
      h.fake.fail(h.fake.payIntent(ref(h, a), 'ach'));
      expect(await load(h, a.loadId)).toMatchObject({ status: 'failed' });
      const b = await start(h, 'load-key-canc1', {}, 'c2');
      h.fake.cancel(h.fake.payIntent(ref(h, b), 'ach'));
      expect(await load(h, b.loadId)).toMatchObject({ status: 'failed' });
    });

    it('Returned is failed with RETURNED, even after it showed Succeeded', async () => {
      const h = harness();
      const l = await start(h);
      const p = h.fake.payIntent(ref(h, l), 'ach');
      h.fake.settle(p);
      expect((await load(h, l.loadId)).status).toBe('on_hold');
      h.fake.returnPayment(p);
      expect(await load(h, l.loadId)).toMatchObject({ status: 'failed', failureCode: 'RETURNED' });
    });

    it('Refunded is failed with REFUNDED', async () => {
      const h = harness();
      const l = await start(h);
      const p = h.fake.payIntent(ref(h, l), 'card');
      h.fake.refundCard(p);
      expect(await load(h, l.loadId)).toMatchObject({ status: 'failed', failureCode: 'REFUNDED' });
    });

    it('a second attempt after a Failed one is the same load', async () => {
      const h = harness();
      const l = await start(h);
      h.fake.fail(h.fake.payIntent(ref(h, l), 'ach'));
      expect((await load(h, l.loadId)).status).toBe('failed');
      const second = h.fake.payIntent(ref(h, l), 'card');
      expect(await load(h, l.loadId)).toMatchObject({ loadId: l.loadId, status: 'succeeded', method: 'card' });
      expect(h.fake.count('intents')).toBe(1);
      expect(second).toBeTruthy();
    });

    it('a load can be read by its payment ref once a payment exists, also by a second adapter on the same ledger', async () => {
      const h = harness();
      const l = await start(h);
      expect((await load(h, l.loadId)).metadata).toBeUndefined();
      const p = h.fake.payIntent(ref(h, l), 'card');
      const byIntent = await load(h, l.loadId);
      const paymentLoadId = `crowded:${h.chapterId}:${p}`;
      expect(byIntent.metadata?.paymentLoadId).toBe(paymentLoadId);
      expect(await load(h, paymentLoadId)).toEqual({ ...byIntent, loadId: paymentLoadId });
      const other = harness({ fake: h.fake, chapterId: h.chapterId, ledger: h.ledger, clock: h.clock });
      expect((await other.adapter.getLoad(paymentLoadId)).status).toBe('succeeded');
    });

    it('records the fee on the metadata and never changes the amount: the payer covered it on top, the net is the load amount', async () => {
      const h = harness();
      h.fake.collectFee = { fee: 150n, covered: true };
      const l = await start(h);
      h.fake.payIntent(ref(h, l), 'card');
      const r = await load(h, l.loadId);
      expect(r).toMatchObject({ status: 'succeeded', amount });
      expect(r.metadata).toMatchObject({ feeMinor: '150', feeCovered: 'true' });
    });

    it('a chapter-absorbed fee leaves the amount as it is', async () => {
      const h = harness();
      h.fake.collectFee = { fee: 150n, covered: false };
      const l = await start(h);
      h.fake.payIntent(ref(h, l), 'card');
      const r = await load(h, l.loadId);
      expect(r).toMatchObject({ status: 'succeeded', amount });
      expect(r.metadata).toMatchObject({ feeMinor: '150', feeCovered: 'false' });
    });

    it('a Succeeded payment whose net differs from the load is not guessed at: processing, and the load stays open', async () => {
      const h = harness();
      const l = await start(h);
      h.fake.payIntent(ref(h, l), 'card', { amount: 9_900n });
      const r = await load(h, l.loadId);
      expect(r).toMatchObject({ status: 'processing', amount, method: 'card' });
      expect(r.holdUntil).toBeUndefined();
    });
  });

  describe('input', () => {
    it('a non-USD or too small amount is VALIDATION_FAILED and nothing is sent', async () => {
      const h = harness();
      for (const a of [money(10_000n, 'ILS'), money(99n, 'USD'), money(0n, 'USD'), money(-5n, 'USD'), money(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'USD')]) {
        expect(await attempt(h.adapter.createLoad({ customerId: 'c1', method: 'hosted', amount: a, hosted }, 'load-key-bad1'))).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(h.fake.calls.length).toBe(0);
    });

    it('refuses every method but hosted and refunds as UNSUPPORTED_METHOD, and every webhook as BAD_SIGNATURE', async () => {
      const h = harness();
      expect(await attempt(h.adapter.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: 'pm' }, 'load-key-card'))).toMatchObject({ code: 'UNSUPPORTED_METHOD' });
      expect(await attempt(h.adapter.refund({ loadId: 'crowded:x:y', amount }, 'refund-key-1'))).toMatchObject({ code: 'UNSUPPORTED_METHOD' });
      expect(await attempt(h.adapter.getRefund('r'))).toMatchObject({ code: 'UNSUPPORTED_METHOD' });
      expect(await attempt(h.adapter.parseWebhook({}, '{}'))).toMatchObject({ code: 'BAD_SIGNATURE' });
      expect(h.fake.calls.length).toBe(0);
    });

    it('an empty or over-long idempotency key and a missing customer are VALIDATION_FAILED', async () => {
      const h = harness();
      for (const [customerId, key] of [['c1', ''], ['c1', 'k'.repeat(129)], ['', 'load-key-0001']] as const) {
        expect(await attempt(h.adapter.createLoad({ customerId, method: 'hosted', amount, hosted }, key))).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(h.fake.calls.length).toBe(0);
    });

    it('without a resolver the customer is a contact ref (c:<id>) from the member adapter, and any other string is refused', async () => {
      const h = harness({ opts: { contactOf: undefined as never } });
      const contactRef = await h.contactOf('c1');
      const l = await h.adapter.createLoad({ customerId: contactRef, method: 'hosted', amount, hosted }, 'load-key-ref1');
      expect(l.status).toBe('requires_action');
      for (const bad of ['c1', 'a:1', 'c:', 'c:../x', 'c:1/2']) {
        expect(await attempt(h.adapter.createLoad({ customerId: bad, method: 'hosted', amount, hosted }, `load-key-${bad.length}`))).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });

    it('takes the payer address as given, only a public one, and sends it with the consent to the intent', async () => {
      const h = harness();
      for (const bad of ['10.0.0.1', '127.0.0.1', '::1', '', 'localhost', '203.0.113.7:80']) {
        expect(await attempt(start(h, `load-key-ip-${bad.length}`, { payerIp: bad }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(await attempt(start(h, 'load-key-nc', { userConsented: false }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(h.fake.count('collections')).toBe(0);
      const l = await start(h, 'load-key-v6', { payerIp: '2606:4700:4700::1111' });
      expect(h.fake.intentRequest(intentId(l.loadId)).payerIp).toBe('2606:4700:4700::1111');
    });
  });

  describe('redirect urls', () => {
    it('only https urls on an allowed host are accepted: another host, a lookalike, a subdomain, http and credentials are refused with nothing sent', async () => {
      const h = harness();
      const bad = ['https://evil.example/ok', 'https://app.example.evil.example/ok', 'https://sub.app.example/ok', 'https://app.example:8443/ok', 'http://app.example/ok', 'https://user:pw@app.example/ok', 'https://app.example@evil.example/ok', 'javascript:alert(1)', '//app.example/ok', 'not a url'];
      for (const [i, url] of bad.entries()) {
        for (const field of ['successUrl', 'failureUrl']) {
          const r = await attempt(start(h, `load-key-url-${i}-${field.length}`, { [field]: url }));
          expect(r, `${field} ${url}`).toMatchObject({ code: 'VALIDATION_FAILED' });
          expect((r as Error).message).not.toMatch(/evil|pw|alert/);
        }
      }
      expect(collectionCalls(h).length).toBe(0);
      expect(h.fake.count('collections')).toBe(0);
    });

    it('sends the normalised href with the {intentId} placeholder, keeping the query and fragment', async () => {
      const h = harness();
      const l = await start(h, 'load-key-url-ok', { successUrl: 'https://APP.example/ok?a=1#done', failureUrl: 'https://APP.example' });
      const sent = h.fake.intentRequest(intentId(l.loadId));
      expect(sent.successUrl).toBe('https://app.example/ok?a=1&intentId={intentId}#done');
      expect(sent.failureUrl).toBe('https://app.example/?intentId={intentId}');
    });

    it('a caller-made intentId parameter is replaced, not trusted', async () => {
      const h = harness();
      const l = await start(h, 'load-key-url-pl', { successUrl: 'https://app.example/ok?intentId=evil&b=2' });
      expect(h.fake.intentRequest(intentId(l.loadId)).successUrl).toBe('https://app.example/ok?b=2&intentId={intentId}');
    });

    it('sends no urls when none are given', async () => {
      const h = harness();
      const l = await start(h);
      expect(h.fake.intentRequest(intentId(l.loadId))).toMatchObject({ successUrl: undefined, failureUrl: undefined });
    });

    it('a payment page from Crowded that is not https is PROVIDER_UNAVAILABLE and is not handed out', async () => {
      const h = harness();
      h.fake.paymentUrlBase = 'http://pay.fake.invalid';
      expect(await attempt(start(h))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });
  });

  describe('expiresAt', () => {
    it('is set from the configured page lifetime, persisted per load and never moves', async () => {
      const h = harness({ opts: { pageTtlMs: 3_600_000 } });
      const l = await start(h);
      expect(l.action?.expiresAt).toBe('2026-11-03T10:00:00.000Z');
      h.clock.t = new Date('2026-11-03T09:45:00Z');
      expect((await h.adapter.getLoad(l.loadId)).action?.expiresAt).toBe('2026-11-03T10:00:00.000Z');
      expect((await start(h)).action?.expiresAt).toBe('2026-11-03T10:00:00.000Z'); // a replay does not extend it
      const other = harness({ fake: h.fake, chapterId: h.chapterId, ledger: h.ledger, clock: h.clock, opts: { pageTtlMs: 3_600_000 } });
      expect((await other.adapter.getLoad(l.loadId)).action?.expiresAt).toBe('2026-11-03T10:00:00.000Z');
    });

    it('is left out when no lifetime is configured, and gone once the payer has paid', async () => {
      const h = harness();
      const l = await start(h);
      expect(l.action).toBeDefined();
      expect('expiresAt' in l.action!).toBe(false);
      const t = harness({ opts: { pageTtlMs: 60_000 } });
      const m = await start(t);
      t.fake.payIntent(`${t.chapterId}:x:${intentId(m.loadId)}`, 'card');
      expect((await t.adapter.getLoad(m.loadId)).action).toBeUndefined();
    });
  });

  describe('unknown loads', () => {
    it('are UNKNOWN_LOAD, and a malformed or foreign ref sends nothing', async () => {
      const h = harness();
      const l = await start(h);
      const before = h.fake.calls.length;
      for (const id of ['nope', '', 'crowded', 'crowded:x', `crowded:other:${intentId(l.loadId)}`, 'crowded:a:b:c', `crowded:${h.chapterId}:../x`, `crowded:${h.chapterId}:a%2Fb`, `stripe:${h.chapterId}:${intentId(l.loadId)}`, `crowded:${h.chapterId}:int999999`]) {
        expect(await attempt(h.adapter.getLoad(id)), id).toMatchObject({ code: 'UNKNOWN_LOAD' });
      }
      expect(h.fake.calls.length).toBe(before);
      expect(await attempt(h.adapter.getLoad('nope'))).toBeInstanceOf(FundingError);
    });

    it('an intent that Crowded no longer has is UNKNOWN_LOAD', async () => {
      const h = harness();
      const l = await start(h);
      const gone = new FakeCrowded({ token: TOKEN, now: () => h.clock.t });
      const chapter = gone.seedChapter();
      const stray = harness({ fake: gone, chapterId: chapter, ledger: h.ledger, clock: h.clock });
      const r = await attempt(stray.adapter.getLoad(`crowded:${chapter}:${intentId(l.loadId)}`));
      expect(r).toMatchObject({ code: 'UNKNOWN_LOAD' });
    });

    it('a Crowded outage on a read is PROVIDER_UNAVAILABLE', async () => {
      const h = harness();
      const l = await start(h);
      h.fake.outageRequests = 1;
      expect(await attempt(h.adapter.getLoad(l.loadId))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });
  });

  describe('personal data and secrets', () => {
    it('stores no address, url or customer in clear and no unsalted hash of them: the ledger holds keyed MACs and vendor ids', async () => {
      const writes: string[] = [];
      const inner = new InMemoryKeyLedger();
      const ledger: KeyLedger = { get: (k) => inner.get(k), put: async (k, e) => (writes.push(JSON.stringify([k, e])), inner.put(k, e)) };
      const h = harness({ ledger });
      await start(h, 'load-key-pii1', { successUrl: 'https://app.example/ok', failureUrl: 'https://app.example/no' });
      const all = writes.join('\n');
      const sha = (s: string) => createHash('sha256').update(s).digest('hex');
      for (const secret of [IP, 'app.example', sha(IP), sha('c1'), sha('https://app.example/ok'), sha(JSON.stringify([IP]))]) expect(all).not.toContain(secret);
      // a different secret gives different stored values: the digest is keyed
      const other = new InMemoryKeyLedger();
      const w2 = harness({ ledger: other, opts: { hmacKey: 'another-test-only-mac-key-0123456789ab' } });
      await start(w2, 'load-key-pii1', { successUrl: 'https://app.example/ok', failureUrl: 'https://app.example/no' });
      const k = 'load:key:load-key-pii1';
      expect((await inner.get(k))!.body).not.toBe((await other.get(k))!.body);
    });

    it('never puts the payer address, a url or the token in an error or a log line', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      try {
        const h = harness();
        const errors: Error[] = [];
        errors.push((await attempt(start(h, 'load-key-e1', { payerIp: '10.1.2.3' }))) as Error);
        errors.push((await attempt(start(h, 'load-key-e2', { successUrl: 'https://user:pw@evil.example/x?token=abc' }))) as Error);
        h.fake.failIntents = 1;
        errors.push((await attempt(start(h, 'load-key-e3'))) as Error);
        errors.push((await attempt(h.adapter.getLoad('crowded:x:y'))) as Error);
        await start(h, 'load-key-e4');
        errors.push((await attempt(start(h, 'load-key-e4', { successUrl: 'https://app.example/198.51.100.99' }))) as Error); // key reused
        for (const e of errors) {
          expect(e).toBeInstanceOf(FundingError);
          const text = `${e.message} ${e.stack ?? ''} ${JSON.stringify(e)} ${String(e)}`;
          for (const secret of ['10.1.2.3', '203.0.113', '198.51.100', 'evil', 'pw@', 'token=abc', TOKEN, MAC_KEY]) expect(text).not.toContain(secret);
        }
        for (const s of spies) expect(s).not.toHaveBeenCalled();
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });

  describe('payments seen on an intent, the first-seen hold instant, ledger failures, the payer address (T-0703)', () => {
    it('every payment seen on an intent names its load, not only the standing one', async () => {
      const h = harness();
      const l = await start(h);
      const first = h.fake.payIntent(ref(h, l), 'ach');
      h.fake.fail(first);
      const second = h.fake.payIntent(ref(h, l), 'card');
      const r = await h.adapter.getLoad(l.loadId);
      expect(r).toMatchObject({ status: 'succeeded', metadata: { paymentLoadId: `crowded:${h.chapterId}:${second}` } });
      // The failed first payment, which is not the standing one, still resolves to the same load, and to its state.
      const viaFirst = await h.adapter.getLoad(`crowded:${h.chapterId}:${first}`);
      expect(viaFirst).toMatchObject({ loadId: `crowded:${h.chapterId}:${first}`, status: 'succeeded' });
      expect(viaFirst.metadata).toMatchObject({ intentLoadId: l.loadId });
      expect(await h.adapter.getLoad(`crowded:${h.chapterId}:${second}`)).toMatchObject({ status: 'succeeded' });
    });

    it('a payment never seen on a read of its intent is UNKNOWN_LOAD with no request', async () => {
      const h = harness();
      const l = await start(h);
      const p = h.fake.payIntent(ref(h, l), 'ach');
      const before = h.fake.calls.length;
      expect(await attempt(h.adapter.getLoad(`crowded:${h.chapterId}:${p}`))).toMatchObject({ code: 'UNKNOWN_LOAD' });
      expect(h.fake.calls.length).toBe(before);
    });

    it('holdUntil is fixed at the first read that sees the success: a later change of the payment\'s updatedAt does not move it', async () => {
      let drift = 0;
      const wrap = (f: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
        const res = await f(input, init);
        if (drift === 0 || !String(input).includes('/intents/')) return res;
        const body = (await res.json()) as { data?: { payments?: { updatedAt: string }[] } };
        for (const p of body.data?.payments ?? []) p.updatedAt = new Date(new Date(p.updatedAt).getTime() + drift).toISOString();
        return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
      };
      const h = harness({ clock: { t: new Date('2026-11-05T09:30:00Z') }, wrap });
      const l = await start(h);
      h.fake.settle(h.fake.payIntent(ref(h, l), 'ach'));
      const first = await h.adapter.getLoad(l.loadId);
      expect(first.holdUntil).toBe('2026-11-10T09:30:00.000Z');
      drift = 3 * 86_400_000;
      h.clock.t = new Date(h.clock.t.getTime() + drift);
      const later = await h.adapter.getLoad(l.loadId);
      expect(later.holdUntil).toBe(first.holdUntil);
      // A second adapter on the same ledger agrees.
      const other = harness({ fake: h.fake, chapterId: h.chapterId, ledger: h.ledger, clock: h.clock, wrap });
      expect((await other.adapter.getLoad(l.loadId)).holdUntil).toBe(first.holdUntil);
    });

    it('a ledger that cannot be read or written is PROVIDER_UNAVAILABLE, with fixed text', async () => {
      for (const broken of ['get', 'put'] as const) {
        const inner = new InMemoryKeyLedger();
        let armed = false;
        const ledger: KeyLedger = {
          get: async (k) => (armed && broken === 'get' ? Promise.reject(new Error('db down postgres://secret@host/x')) : inner.get(k)),
          put: async (k, v) => (armed && broken === 'put' ? Promise.reject(new Error('db down postgres://secret@host/x')) : inner.put(k, v)),
        };
        const h = harness({ ledger });
        const l = await start(h);
        h.fake.settle(h.fake.payIntent(ref(h, l), 'ach'));
        armed = true;
        for (const op of [() => start(h, 'load-key-0002'), () => h.adapter.getLoad(l.loadId)]) {
          const e = await attempt(op());
          expect(e, broken).toBeInstanceOf(FundingError);
          expect(e, broken).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
          expect((e as Error).message).not.toContain('postgres');
        }
      }
    });

    it('a retry of one key from another payer address is the same load (the address is a connection attribute, not input); a non-public one is still refused', async () => {
      const h = harness();
      const a = await start(h);
      const calls = h.fake.calls.length;
      const b = await start(h, 'load-key-0001', { payerIp: '198.51.100.9' });
      expect(b).toEqual(a);
      expect(h.fake.count('intents')).toBe(1);
      expect(h.fake.calls.length).toBe(calls + 1); // the one read of the intent
      expect(await attempt(start(h, 'load-key-0001', { payerIp: '10.0.0.1' }))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('parseWebhook is BAD_SIGNATURE even for a validly signed Crowded batch, and sends nothing', async () => {
      const h = harness();
      const signed = h.fake.webhook([{ eventType: 'collect.payment.succeeded', data: { paymentId: 'p1' }, chapterId: h.chapterId }]);
      expect(await attempt(h.adapter.parseWebhook(signed.headers, signed.rawBody))).toMatchObject({ code: 'BAD_SIGNATURE' });
      expect(h.fake.calls.length).toBe(0);
    });
  });

  describe('configuration crashes on boot', () => {
    const base = () => {
      const h = harness();
      return { client: h.client, chapterId: h.chapterId, hmacKey: MAC_KEY, achHoldDays: 3, redirectHosts: ['app.example'] } satisfies CrowdedFundingOptions;
    };
    it('needs the hold days (an integer from 0), the allowlist (bare lower-case hosts), a chapter and a key of 32 characters', () => {
      expect(() => new CrowdedFunding(base())).not.toThrow();
      const bad: Array<Partial<CrowdedFundingOptions>> = [
        { achHoldDays: undefined as never },
        { achHoldDays: -1 },
        { achHoldDays: 1.5 },
        { achHoldDays: 400 },
        { redirectHosts: [] },
        { redirectHosts: undefined as never },
        { redirectHosts: ['*.example'] },
        { redirectHosts: ['https://app.example'] },
        { redirectHosts: ['app.example/path'] },
        { redirectHosts: ['user@app.example'] },
        { redirectHosts: [''] },
        { chapterId: '' },
        { chapterId: 'a/b' },
        { hmacKey: 'short' },
        { hmacKey: undefined as never },
        { pageTtlMs: 0 },
        { pageTtlMs: -1 },
      ];
      for (const over of bad) expect(() => new CrowdedFunding({ ...base(), ...over }), JSON.stringify(Object.keys(over))).toThrow();
    });
  });
});

describe('hardening follow-ups (T-0735, TST-INS-006)', () => {
  it('two concurrent keys with one colliding title adopt an unclaimed collection once: one create, one found', async () => {
    const h = harness();
    const keyA = `${'k'.repeat(60)}a`;
    const keyB = `${'k'.repeat(60)}b`;
    const title = `Load ${keyA}`.slice(0, 50);
    // A collection a lost answer left behind: right title and amount, claimed by no key.
    await h.client.post(`/chapters/${h.chapterId}/collections`, { title, requestedAmount: Number(amount.minor) });
    const [a, b] = await Promise.all([start(h, keyA, {}, 'c1'), start(h, keyB, {}, 'c2')]);
    expect(a.loadId).not.toBe(b.loadId);
    expect(h.fake.count('collections')).toBe(2); // the one that was there, and one create
    const intentPaths = h.fake.calls.filter((c) => c.method === 'POST' && /collections\/[^/]+\/intents$/.test(c.path)).map((c) => c.path);
    expect(new Set(intentPaths).size).toBe(2); // never two loads on one collection
  });

  it('a key whose claim of its own fresh collection lost to another key looks again: no two loads on one collection', async () => {
    // A creates X and is held before it can claim; B lists, finds X unclaimed and claims it; A must not carry on with X.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const wrap = (f: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
      const res = await f(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!held && (init?.method ?? 'GET') === 'POST' && /\/collections$/.test(url)) {
        held = true;
        await gate;
      }
      return res;
    };
    const h = harness({ wrap });
    const keyA = `${'k'.repeat(60)}a`;
    const keyB = `${'k'.repeat(60)}b`;
    const a = start(h, keyA, {}, 'c1');
    while (h.fake.count('collections') < 1) await new Promise((r) => setTimeout(r, 1));
    const b = await start(h, keyB, {}, 'c2');
    release();
    const la = await a;
    expect(la.loadId).not.toBe(b.loadId);
    const intentPaths = h.fake.calls.filter((c) => c.method === 'POST' && /collections\/[^/]+\/intents$/.test(c.path)).map((c) => c.path);
    expect(new Set(intentPaths).size).toBe(2);
    expect(h.fake.count('collections')).toBe(2);
  });

  it('strips intentId from a redirect by string: the other parameters keep their bytes', async () => {
    const h = harness();
    const l = await start(h, 'load-key-url-qs', { successUrl: 'https://app.example/ok?q=a%20b+c~d&k=1&intentId=evil&k=2&sp=x%2By' });
    expect(h.fake.intentRequest(intentId(l.loadId)).successUrl).toBe('https://app.example/ok?q=a%20b+c~d&k=1&k=2&sp=x%2By&intentId={intentId}');
    const only = await start(h, 'load-key-url-q2', { successUrl: 'https://app.example/ok?intentId=evil' });
    expect(h.fake.intentRequest(intentId(only.loadId)).successUrl).toBe('https://app.example/ok?intentId={intentId}');
  });

  it('carries the payment and intent refs as string metadata on the port Load, and none before a payment exists', async () => {
    const h = harness();
    const l = await start(h);
    expect((await h.adapter.getLoad(l.loadId)).metadata).toBeUndefined();
    h.fake.payIntent(ref(h, l), 'card');
    const paid = await h.adapter.getLoad(l.loadId);
    const md: Readonly<Record<string, string>> | undefined = paid.metadata;
    expect(md).toMatchObject({ intentLoadId: l.loadId });
    expect(Object.values(md!).every((v) => typeof v === 'string')).toBe(true);
  });
});

// ---- the wallet credit (T-0741, TST-WAL-003): FUNDING CREDIT against the fake. Fake-only: fund holding is off in the sandbox (README q29). ----
function creditHarness(fundHolding: boolean, over: { creditOpts?: Partial<NonNullable<CrowdedFundingOptions['credit']>> } = {}) {
  const clock = { t: new Date('2026-11-03T09:00:00Z') };
  const fake = new FakeCrowded({ token: TOKEN, pageSize: 2, now: () => clock.t });
  const chapterId = fake.seedChapter();
  const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: fake.fetch });
  const mirror = new CrowdedMirror({ client, chapterId });
  fake.fundHolding = fundHolding;
  // With holding off the collected money is expected in the chapter's account already (README q35): the test puts it there.
  if (!fundHolding) fake.setChecking(chapterId, 1_000_000n);
  const h = harness({ fake, chapterId, clock, opts: { credit: { mirror, fundHolding, ...over.creditOpts } } });
  const members = new CrowdedMemberAccounts({ client, chapterId, hmacKey: MAC_KEY, ledger: new InMemoryKeyLedger(), now: () => clock.t });
  let seq = 0;
  const member = async () => {
    const n = ++seq;
    const mobile = `+1415556${String(1000 + n)}`;
    const e = await members.ensureAccount({ partyId: `m${n}`, firstName: 'Member', lastName: 'Test', email: `m${n}@example.test`, mobile, dateOfBirth: '1990-01-01' }, `ensure-member-${n}`);
    if (!('accountRef' in e)) throw new Error('no account');
    return { accountRef: e.accountRef, walletId: fake.walletId(fake.contactId(mobile)) };
  };
  let loads = 0;
  type State = 'succeeded' | 'processing' | 'requires_action' | 'failed' | 'on_hold' | 'returned';
  const loadIn = async (state: State, amt = amount): Promise<string> => {
    const n = ++loads;
    const l = await h.adapter.createLoad({ customerId: `cust${n}`, method: 'hosted', amount: amt, hosted }, `credit-load-${n}`);
    const r = ref(h, l);
    if (state === 'requires_action') return l.loadId;
    if (state === 'succeeded') {
      h.fake.payIntent(r, 'card');
      return l.loadId;
    }
    return achIn(r, l.loadId, state);
  };
  const achIn = (r: string, loadId: string, state: 'processing' | 'failed' | 'on_hold' | 'returned'): string => {
    const p = h.fake.payIntent(r, 'ach');
    if (state === 'failed') h.fake.fail(p);
    if (state === 'on_hold' || state === 'returned') h.fake.settle(p);
    if (state === 'returned') h.fake.returnPayment(p);
    return loadId;
  };
  const credit = h.adapter.creditWallet!;
  const memos = (loadId: string) => fake.bookRows(chapterId).filter((b) => b.description.startsWith(`load-credit:${intentId(loadId)}:`));
  const sent = (loadId: string) => memos(loadId).filter((b) => b.status === 'sent').length;
  const bookPosts = () => fake.calls.filter((c) => c.method === 'POST' && c.path === `/chapters/${chapterId}/payments`);
  return { ...h, mirror, member, loadIn, credit, memos, sent, bookPosts, fundHolding };
}
type CreditHarness = ReturnType<typeof creditHarness>;

class CreditPort extends HostedPlusSim {
  readonly c: CreditHarness;
  constructor(c: CreditHarness) {
    super(c);
    this.c = c;
  }
  creditWallet: FundingCreditPort['creditWallet'] = (i, k) => this.c.credit(i, k);
}

for (const fundHolding of [true, false]) {
  // The wire key the contract's first key derives (the mirror namespaces the leg key again): fixtures are one-shot by wire key.
  const firstWire = bookWireKey('mirror:', bookWireKey('credit:', 'credit-key-1'));
  let shared: { accountRef: string; unknownAccountRef: string } | undefined;
  fundingContract(`crowded credit (fake, fundHolding ${String(fundHolding)})`, () => new CreditPort(creditHarness(fundHolding)), {
    goodPaymentMethod: 'pm_card_ok',
    declinedPaymentMethod: 'pm_declined',
    outagePaymentMethod: 'pm_outage',
    achPaymentMethod: 'pm_bank_ok',
    succeededWebhook: async (port, id) => (port as HostedPlusSim).sim.webhookFor(id, 'succeeded'),
    norefundPaymentMethod: 'pm_norefund',
    hosted: true,
    credit: {
      // Each port is its own fake; the account is made lazily per port in `loadIn`, so these are placeholders replaced by `accountFor`.
      get accountRef() {
        return shared?.accountRef ?? 'a:pending';
      },
      unknownAccountRef: 'a:999999',
      loadIn: async (port, state, amt) => {
        const p = port as CreditPort;
        const m = await p.c.member();
        shared = { accountRef: m.accountRef, unknownAccountRef: 'a:999999' };
        return p.c.loadIn(state, amt);
      },
      creditCount: (port, loadId) => (port as CreditPort).c.sent(loadId),
      failNext: (port, code) => {
        const f = (port as CreditPort).c.fake;
        if (code === 'INSUFFICIENT_FUNDS') f.bookStatus(firstWire, 'Rejected');
        else f.refuseBook(firstWire, code);
      },
      pendNext: (port) => {
        const f = (port as CreditPort).c.fake;
        f.bookStatus(firstWire, 'Pending');
        f.autoSettlePendingBook = true;
      },
      outageNext: (port) => {
        (port as CreditPort).c.fake.outageRequests = 1;
      },
    },
  });
}

describe('CrowdedFunding wallet credit (T-0741, TST-WAL-003)', () => {
  const key = 'wf-credit-0001:credit:1';
  const money10k = { amount };
  const input = (loadId: string, accountRef: string) => ({ loadId, accountRef, ...money10k });

  it('fundHolding true: one release for the amount, then one book payment to the member; pool down, balance up; the memo is ours', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    expect(c.fake.heldPool(c.chapterId)).toBe(10_000n);
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'credited' });
    expect(c.fake.releaseRequests).toBe(1);
    const rel = c.fake.calls.find((x) => x.path.endsWith('/release-funds'))!;
    expect((rel.body as { data: Record<string, unknown> }).data['amount']).toBe(10_000);
    expect(c.fake.heldPool(c.chapterId)).toBe(0n);
    expect((await c.mirror.accountBalance(m.accountRef)).balance).toBe(10_000n);
    const row = c.memos(loadId);
    expect(row).toHaveLength(1);
    expect(row[0]!.description).toMatch(/^load-credit:[A-Za-z0-9_-]+:a1$/);
    expect(row[0]!.description.length).toBeLessThanOrEqual(80);
    expect(row[0]!.description).not.toMatch(/Member|Test|example|\+1/);
  });

  it('fundHolding false: no release request at all, only the book payment', async () => {
    const c = creditHarness(false);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'credited' });
    expect(c.fake.releaseRequests).toBe(0);
    expect(c.fake.calls.some((x) => x.path.endsWith('/release-funds') || x.path === '/collect-payments')).toBe(false);
    expect((await c.mirror.accountBalance(m.accountRef)).balance).toBe(10_000n);
    expect(c.sent(loadId)).toBe(1);
  });

  it('the same key twice makes one release and one book payment, and sends nothing the second time', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    await c.credit(input(loadId, m.accountRef), key);
    const before = c.fake.calls.length;
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'credited' });
    expect(c.fake.calls.length).toBe(before);
    expect(c.fake.releaseRequests).toBe(1);
    expect(c.sent(loadId)).toBe(1);
  });

  it('a first call that died after the release is finished by the next call: no second release, one book payment', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.loseNextResponse(); // the release is processed, its answer is lost
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'pending' });
    expect(c.fake.releaseCount(c.chapterId)).toBe(1);
    expect(c.sent(loadId)).toBe(0);
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'credited' });
    expect(c.fake.releaseRequests).toBe(1);
    expect(c.fake.releaseCount(c.chapterId)).toBe(1);
    expect(c.sent(loadId)).toBe(1);
    // The release key is a UUID v4 of ours in its own namespace.
    const rel = c.fake.calls.find((x) => x.path.endsWith('/release-funds'))!;
    expect((rel.body as { data: { idempotencyKey: string } }).data.idempotencyKey).toBe(bookWireKey('credit:release:', key));
  });

  it('a release the vendor Rejects is refused with the port reason, nothing is booked, and the refusal is final for the key', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.rejectNextRelease('AccountFrozen');
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
    expect(c.bookPosts()).toHaveLength(0);
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
    expect(c.fake.releaseRequests).toBe(1);
    // A NEW key makes a new attempt (its own memo) and credits.
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0001:credit:2')).toEqual({ status: 'credited' });
    expect(c.memos(loadId).map((b) => b.description)[0]).toMatch(/:a2$/);
  });

  it('a book payment refused for lack of funds at checking is refused INSUFFICIENT_FUNDS; its retry under a new key reads its own payment', async () => {
    const c = creditHarness(false);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.setChecking(c.chapterId, 0n);
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0002:credit:1')).toEqual({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
    c.fake.setChecking(c.chapterId, 50_000n);
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0002:credit:2')).toEqual({ status: 'credited' });
    expect(c.memos(loadId).map((b) => [b.description.split(':').at(-1), b.status])).toEqual([['a1', 'failed'], ['a2', 'sent']]);
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0002:credit:2')).toEqual({ status: 'credited' });
  });

  it('a Pending book payment answers pending; another key for that load never books beside it; the same key credits once it settles', async () => {
    const c = creditHarness(false);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.bookStatus(bookWireKey('mirror:', bookWireKey('credit:', 'wf-credit-0003:credit:1')), 'Pending');
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0003:credit:1')).toEqual({ status: 'pending' });
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0003:credit:2')).toEqual({ status: 'pending' });
    expect(c.bookPosts()).toHaveLength(1);
    c.fake.settleBook(c.memos(loadId)[0]!.id);
    expect(await c.credit(input(loadId, m.accountRef), 'wf-credit-0003:credit:1')).toEqual({ status: 'credited' });
    expect(c.bookPosts()).toHaveLength(1);
    expect(c.sent(loadId)).toBe(1);
  });

  it('a lost book answer is found again by its memo, never resent under a new key', async () => {
    const c = creditHarness(false);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.loseNextResponse();
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'pending' });
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'credited' });
    expect(c.bookPosts()).toHaveLength(1);
    expect(c.sent(loadId)).toBe(1);
  });

  it.each(['returned', 'failed', 'processing', 'on_hold'] as const)('a %s payment is refused NOT_SUCCEEDED with no money call', async (state) => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn(state);
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'refused', reasonCode: 'NOT_SUCCEEDED' });
    expect(c.fake.releaseRequests).toBe(0);
    expect(c.bookPosts()).toHaveLength(0);
  });

  it('release-funds answering 403 is PROVIDER_UNAVAILABLE with fixed text naming fund holding, nothing booked', async () => {
    const c = creditHarness(true);
    c.fake.fundHolding = false; // the sandbox as it is today
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    const e = await attempt(c.credit(input(loadId, m.accountRef), key));
    expect(e).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((e as Error).message).toMatch(/fund holding/i);
    expect((e as Error).message).not.toMatch(/Held collection payments|403/);
    expect(c.bookPosts()).toHaveLength(0);
  });

  it.each(['Frozen', 'Closed'] as const)('a %s member account is refused ACCOUNT_UNAVAILABLE before any money moves, a stored ref notwithstanding', async (status) => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.setAccountStatus(m.walletId, status);
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
    expect(c.fake.releaseRequests).toBe(0);
    expect(c.bookPosts()).toHaveLength(0);
    expect(c.fake.heldPool(c.chapterId)).toBe(10_000n);
  });

  it('an account that froze between a release that was lost and the retry is refused, the book payment never sent', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    c.fake.loseNextResponse();
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'pending' });
    c.fake.setAccountStatus(m.walletId, 'Frozen');
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
    expect(c.bookPosts()).toHaveLength(0);
  });

  it('an unknown load is UNKNOWN_LOAD and a contact ref is VALIDATION_FAILED, each with no request, and neither is remembered', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    const before = c.fake.calls.length;
    await expect(c.credit(input(`crowded:${c.chapterId}:nope`, m.accountRef), key)).rejects.toMatchObject({ code: 'UNKNOWN_LOAD' });
    await expect(c.credit(input(loadId, 'c:123'), key)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(c.credit(input(loadId, m.accountRef), 'short')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(c.fake.calls.length).toBe(before);
    // The failed calls did not bind the key.
    expect(await c.credit(input(loadId, m.accountRef), key)).toEqual({ status: 'credited' });
  });

  it('the book payment and the release have wire keys of their own, apart from a mirror leg of the same workflow id', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    await c.credit(input(loadId, m.accountRef), key);
    const wire = (c.bookPosts()[0]!.body as { data: { payments: { idempotencyKey: string }[] } }).data.payments[0]!.idempotencyKey;
    expect(wire).toBe(bookWireKey('mirror:', bookWireKey('credit:', key)));
    expect(wire).not.toBe(bookWireKey('mirror:', key));
    expect(bookWireKey('credit:release:', key)).not.toBe(wire);
    expect(bookWireKey('credit:release:', key)).not.toBe(bookWireKey('mirror:', key));
  });

  it('two calls at once on one key, and two keys at once on one load, credit once', async () => {
    const c = creditHarness(true);
    const m = await c.member();
    const loadId = await c.loadIn('succeeded');
    const rs = await Promise.all([c.credit(input(loadId, m.accountRef), key), c.credit(input(loadId, m.accountRef), key), c.credit(input(loadId, m.accountRef), 'wf-credit-0009:credit:1')]);
    expect(rs.map((r) => r.status)).toEqual(['credited', 'credited', 'credited']);
    expect(c.sent(loadId)).toBe(1);
    expect(c.fake.releaseCount(c.chapterId)).toBe(1);
  });

  it('is a FundingCreditPort only when the credit option is given, and fundHolding has no default', () => {
    const plain = harness();
    expect(isFundingCreditPort(plain.adapter)).toBe(false);
    expect(isFundingCreditPort(creditHarness(false).adapter)).toBe(true);
    const mirror = new CrowdedMirror({ client: plain.client, chapterId: plain.chapterId });
    expect(() => new CrowdedFunding({ client: plain.client, chapterId: plain.chapterId, hmacKey: MAC_KEY, achHoldDays: 3, redirectHosts: ['app.example'], credit: { mirror } as never })).toThrow(/fundHolding/);
  });
});

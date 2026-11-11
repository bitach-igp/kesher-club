// CrowdedInstitutionBankingAdapter passes institutionBankingContract against the in-memory FakeCrowded, for an
// institution's own entity and for the platform's (T-0648, REQ-INS-022, REQ-INS-024). Crowded has no per-account pooled
// mode in its docs, so the pooled setup is not run here. A real-sandbox run needs a human to approve the bank
// application, so sandbox.test.ts is a read-only smoke test (skipped without CROWDED_SANDBOX_TOKEN).
import { describe, expect, it, vi } from 'vitest';
import { money } from '@kesher/domain';
import { institutionBankingContract } from '@kesher/ports/contracts';
import { CrowdedClient, redact } from './client.ts';
import { FakeCrowded } from './fake-crowded.ts';
import { CrowdedInstitutionBankingAdapter, InMemoryKeyLedger, type CrowdedInstitutionBankingOptions } from './institution-banking.ts';

const TOKEN = 'crowded_test_token_not_a_secret';
const BASE = 'https://sandbox.fake.invalid/api/v1';
const verify = (h: Record<string, string>) => h['x-webhook-signature'] === 'sha256=fake';

function harness(extra: Partial<CrowdedInstitutionBankingOptions> = {}, token = TOKEN, pageSize = 2) {
  const fake = new FakeCrowded({ token: TOKEN, pageSize });
  const onAuth = vi.fn();
  const adapter = new CrowdedInstitutionBankingAdapter({
    client: new CrowdedClient({ baseUrl: BASE, token, fetch: fake.fetch, onAuthFailure: onAuth }),
    ledger: new InMemoryKeyLedger(),
    subAccountEmail: 'ops@kesher.example',
    collectionCounterpartyRef: 'cp_kesher',
    payer: { ip: '203.0.113.9', consented: true },
    verifyWebhookSignature: verify,
    ...extra,
  });
  return { fake, adapter, onAuth };
}

const fakes = new WeakMap<object, FakeCrowded>();
const make = () => {
  const h = harness();
  fakes.set(h.adapter, h.fake);
  return h.adapter;
};
const fakeOf = (p: object): FakeCrowded => fakes.get(p)!;

const common = {
  approve: async (p: CrowdedInstitutionBankingAdapter, ref: string) => fakeOf(p).decide(ref),
  fund: async (p: CrowdedInstitutionBankingAdapter, ref: string, minor: bigint) => fakeOf(p).fund(ref, minor),
  post: async (p: CrowdedInstitutionBankingAdapter, ref: string, count: number) => fakeOf(p).post(ref, count),
  pay: async (p: CrowdedInstitutionBankingAdapter, intentRef: string) => fakeOf(p).pay(intentRef),
  advanceAch: async (p: CrowdedInstitutionBankingAdapter, ref: string) => fakeOf(p).advanceAch(ref),
  signed: (p: CrowdedInstitutionBankingAdapter) => fakeOf(p).webhook([{ eventType: 'finance.application.approved', chapterId: 'ch000003' }]),
  forge: (n: { headers: Record<string, string>; rawBody: string }) => ({ ...n, headers: { ...n.headers, 'x-webhook-signature': 'sha256=forged' } }),
  outageLegalName: 'OUTAGE Friends',
};
institutionBankingContract('crowded (fake), institution holder', make, { ...common, holder: 'institution' });
institutionBankingContract('crowded (fake), platform holder', make, { ...common, holder: 'platform', legalName: 'Israel Global Pay, LLC' });

const NEW = (key: string, legalName = 'American Friends of Yeshiva Or') => ({ holder: 'institution' as const, institutionId: '0190a0a0-0000-7000-8000-000000000001', legalName, ein: '12-3456789', idempotencyKey: key });
const approvedEntity = async (h: ReturnType<typeof harness>) => {
  const { entityRef } = await h.adapter.createEntity(NEW('key-entity-0001'));
  h.fake.decide(entityRef);
  return entityRef;
};

describe('CrowdedInstitutionBankingAdapter over the fake', () => {
  it('a retry with an empty ledger looks the object up and makes no second organization, chapter or collection', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    const col = { entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' };
    const first = await h.adapter.createCollection(col);
    // A restarted process: same fake, a fresh adapter with nothing remembered.
    const again = harness();
    const second = new CrowdedInstitutionBankingAdapter({ client: new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: h.fake.fetch }), ledger: new InMemoryKeyLedger() });
    expect(await second.createEntity(NEW('key-entity-0001'))).toEqual({ entityRef });
    expect(await second.createCollection(col)).toEqual(first);
    expect([h.fake.count('organizations'), h.fake.count('chapters'), h.fake.count('collections')]).toEqual([1, 1, 1]);
    expect(again.fake.count('organizations')).toBe(0);
  });

  describe('objects are matched on our id, not the name (T-0657)', () => {
    const A = '0190a0a0-0000-7000-8000-00000000000a';
    const B = '0190a0a0-0000-7000-8000-00000000000b';
    const as = (institutionId: string, key: string, legalName = 'American Friends of Yeshiva Or') => ({ holder: 'institution' as const, institutionId, legalName, ein: '12-3456789', idempotencyKey: key });

    it('two institutions with the same legal name get two organizations and two chapters, each named with its own id', async () => {
      const h = harness();
      const a = await h.adapter.createEntity(as(A, 'key-entity-000A'));
      const b = await h.adapter.createEntity(as(B, 'key-entity-000B'));
      expect(a.entityRef).not.toBe(b.entityRef);
      expect([h.fake.count('organizations'), h.fake.count('chapters')]).toEqual([2, 2]);
      expect(h.fake.names('organizations')).toEqual([`American Friends of Yeshiva Or [${A}]`, `American Friends of Yeshiva Or [${B}]`]);
      expect(h.fake.names('chapters')).toEqual([`American Friends of Yeshiva Or [${A}]`, `American Friends of Yeshiva Or [${B}]`]);
    });

    it('a retry after a lost response finds its own organization and chapter even with a namesake present; nothing is made twice; the same id under another legal name is another entity, as the port contract says', async () => {
      const h = harness();
      const a = await h.adapter.createEntity(as(A, 'key-entity-000A'));
      const b = await h.adapter.createEntity(as(B, 'key-entity-000B'));
      const fresh = () => new CrowdedInstitutionBankingAdapter({ client: new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: h.fake.fetch }), ledger: new InMemoryKeyLedger() });
      expect(await fresh().createEntity(as(A, 'key-entity-000A'))).toEqual(a);
      expect(await fresh().createEntity(as(B, 'key-entity-000B'))).toEqual(b);
      expect([h.fake.count('organizations'), h.fake.count('chapters')]).toEqual([2, 2]);
      expect((await fresh().createEntity(as(A, 'key-entity-000C', 'American Friends of Yeshiva Or, Inc.'))).entityRef).not.toBe(a.entityRef);
    });

    it('an id that is not a plain identifier, or a name too long once the id is added, is refused before anything is sent', async () => {
      const h = harness();
      await expect(h.adapter.createEntity(as('x] [evil', 'key-entity-000A'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(h.adapter.createEntity(as(A, 'key-entity-000B', 'N'.repeat(250)))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(h.fake.count('organizations')).toBe(0);
    });

    it('two fee items with the same title and amount get two collections; each retry, with the ledger kept, answers its own', async () => {
      const h = harness();
      const entityRef = await approvedEntity(h);
      const one = { entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-0000A' };
      const two = { ...one, idempotencyKey: 'key-col-0000B' };
      const first = await h.adapter.createCollection(one);
      const second = await h.adapter.createCollection(two);
      expect(first.collectionRef).not.toBe(second.collectionRef);
      expect(h.fake.count('collections')).toBe(2);
      expect(await h.adapter.createCollection(one)).toEqual(first);
      expect(await h.adapter.createCollection(two)).toEqual(second);
      expect(h.fake.count('collections')).toBe(2);
    });

    it('a retry after a lost response, before its collection was noted, reuses it; the next same-titled fee item still gets its own', async () => {
      const h = harness();
      const entityRef = await approvedEntity(h);
      const one = { entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-0000A' };
      const first = await h.adapter.createCollection(one);
      const fresh = new CrowdedInstitutionBankingAdapter({ client: new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: h.fake.fetch }), ledger: new InMemoryKeyLedger() });
      expect(await fresh.createCollection(one)).toEqual(first);
      const next = await fresh.createCollection({ ...one, idempotencyKey: 'key-col-0000B' });
      expect(next.collectionRef).not.toBe(first.collectionRef);
      expect(h.fake.count('collections')).toBe(2);
    });
  });

  it('a 201 whose status says Rejected is a failure', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 100_000n);
    await expect(h.adapter.sendAch({ entityRef, counterpartyRef: 'ach_rejected_201_kesher', amount: money(10_000n, 'USD'), addenda: 'KC-7M4QX2HD', idempotencyKey: 'key-ach-00001' })).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('never returns the account number: last four only, and nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 12_345n);
    const number = h.fake.accountNumber(entityRef);
    const acct = await h.adapter.account(entityRef);
    expect(Object.keys(acct).sort()).toEqual(['accountRef', 'balance', 'last4']);
    expect(acct.last4).toBe(number.slice(-4));
    const text = JSON.stringify(acct, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(text).not.toContain(number);
    expect(text).not.toContain(number.slice(-8));
    expect(text).not.toContain('accountNumber');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a credential failure is reported and read as unavailable; an outage is not retried', async () => {
    const bad = harness({}, 'a_wrong_token');
    await expect(bad.adapter.createEntity(NEW('key-entity-0001'))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(bad.onAuth).toHaveBeenCalledWith(401);

    const h = harness();
    h.fake.outageRequests = 1;
    await expect(h.adapter.createEntity(NEW('key-entity-0001'))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.calls).toHaveLength(1);
  });

  it('refuses without the caller\'s payer consent; sends nothing', async () => {
    const h = harness({ payer: undefined as never });
    const entityRef = await approvedEntity(h);
    const { collectionRef } = await h.adapter.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
    const before = h.fake.calls.length;
    await expect(h.adapter.createPaymentPage({ collectionRef, funder: { name: 'Dana Levi', email: 'dana@example.com', mobile: '+12125550123' }, idempotencyKey: 'key-page-0001' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.fake.calls).toHaveLength(before);
  });

  it('a funder\'s name is split for Crowded; a one-word name serves as both', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    const { collectionRef } = await h.adapter.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
    await h.adapter.createPaymentPage({ collectionRef, funder: { name: 'Dana Ben David Levi', email: 'dana@example.com', mobile: '12125550123' }, idempotencyKey: 'key-page-0001' });
    await h.adapter.createPaymentPage({ collectionRef, funder: { name: 'Madonna', email: 'm@example.com', mobile: '+12125550124' }, idempotencyKey: 'key-page-0002' });
    const intents = h.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/intents')).map((c) => (c.body as { data: Record<string, unknown> }).data);
    expect(intents[0]).toMatchObject({ firstName: 'Dana Ben David', lastName: 'Levi', mobile: '+12125550123', userConsented: true, payerIp: '203.0.113.9' });
    expect(intents[1]).toMatchObject({ firstName: 'Madonna', lastName: 'Madonna' });
  });

  it('with no signature verifier every webhook is refused; objectRef names our ref for the object', async () => {
    const h = harness({ verifyWebhookSignature: undefined as never });
    const n = h.fake.webhook([{ eventType: 'finance.application.approved', chapterId: 'ch000003' }]);
    expect(await h.adapter.parseWebhook(n.headers, n.rawBody)).toEqual({ rejected: 'BAD_SIGNATURE' });

    const ok = harness();
    const batch = ok.fake.webhook([
      { eventType: 'finance.application.approved', chapterId: 'ch000003' },
      { eventType: 'finance.ach_payment.sent', chapterId: 'ch000003', data: { id: 'pay000009' } },
      { eventType: 'platform.chapter.updated' },
    ]);
    const parsed = await ok.adapter.parseWebhook(batch.headers, batch.rawBody);
    expect('events' in parsed && parsed.events.map((e) => [e.type, e.objectRef])).toEqual([
      ['finance.application.approved', 'ch000003'],
      ['finance.ach_payment.sent', 'ch000003:pay000009'],
      ['platform.chapter.updated', undefined],
    ]);
  });

  it('a book transfer only goes parent to sub-account, through the funding call', async () => {
    const h = harness();
    const platform = await h.adapter.createEntity({ ...NEW('key-entity-0009', 'Israel Global Pay, LLC'), holder: 'platform' });
    h.fake.decide(platform.entityRef);
    h.fake.fund(platform.entityRef, 500_000n);
    const sub = await h.adapter.createSubAccount({ entityRef: platform.entityRef, institutionId: '0190a0a0-0000-7000-8000-000000000101', idempotencyKey: 'key-sub-00001' });
    const book = (fromRef: string, toRef: string, key: string) => h.adapter.bookTransfer({ fromRef, toRef, amount: money(1_000n, 'USD'), memo: 'KC-7M4QX2HD', idempotencyKey: key });
    await expect(book(sub.subAccountRef, platform.entityRef, 'key-book-0001')).rejects.toBeInstanceOf(Error);
    await book(platform.entityRef, sub.subAccountRef, 'key-book-0002');
    expect(h.fake.calls.filter((c) => c.path.endsWith('/subaccounts/fund'))).toHaveLength(1);
  });
});

// ---- hardening (Opus review of T-0648) ---------------------------------------------------------------------------------

type Harness = ReturnType<typeof harness>;
/** A second adapter over the same fake with an empty ledger (a restarted process), with a hook on the wire. */
function restarted(h: Harness, hook?: (url: string, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>, extra: Partial<CrowdedInstitutionBankingOptions> = {}) {
  const fetch: typeof globalThis.fetch = async (input, init) => (await hook?.(String(input), init)) ?? h.fake.fetch(input, init);
  return new CrowdedInstitutionBankingAdapter({
    client: new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch }),
    ledger: new InMemoryKeyLedger(),
    subAccountEmail: 'ops@kesher.example',
    collectionCounterpartyRef: 'cp_kesher',
    ...extra,
  });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ach = (entityRef: string, key = 'key-ach-00001', minor = 10_000n) => ({ entityRef, counterpartyRef: 'cp_kesher', amount: money(minor, 'USD'), addenda: 'KC-7M4QX2HD', idempotencyKey: key });
const paid = async (h: Harness, entityRef: string) => {
  const { collectionRef } = await h.adapter.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
  const { intentRef } = await h.adapter.createPaymentPage({ collectionRef, funder: { name: 'Dana Levi', email: 'dana@example.com', mobile: '+12125550123' }, idempotencyKey: 'key-page-0001' });
  h.fake.pay(intentRef);
};
const first = async (it: AsyncIterable<{ amount: { minor: bigint } }>) => {
  for await (const x of it) return x;
  return undefined;
};

describe('hardening', () => {
  it('a fee the payer covered comes off the amount; a fee that does not fit the payment is refused', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.collectFee = { fee: 500n, covered: true };
    await paid(h, entityRef);
    expect((await first(h.adapter.collectPayments({ entityRef, since: new Date('2026-01-01') })))?.amount.minor).toBe(44_500n);
    h.fake.collectFee = { fee: 45_000n, covered: true };
    await expect(first(h.adapter.collectPayments({ entityRef, since: new Date('2026-01-01') }))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a quote with no fee is an error, not a free ACH', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.quoteWithoutFee = true;
    await expect(h.adapter.quoteAch({ entityRef, amount: money(10_000n, 'USD') })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('provider text is masked before it reaches an error message', async () => {
    const text = redact('Account 000123456789 for dana@example.com / +1 (212) 555-0123 is invalid; routing 084106768');
    expect(text).not.toMatch(/\d{5,}|@example|555-0123/);
    const h = harness();
    const entityRef = await approvedEntity(h);
    const b = restarted(h, (url, init) => (init?.method === 'POST' && url.endsWith('/quotes/ach') ? json(400, { message: 'Account 000123456789 is closed for dana@example.com' }) : undefined));
    const e = await b.quoteAch({ entityRef, amount: money(10_000n, 'USD') }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((e as Error).message).not.toMatch(/000123456789|dana@/);
  });

  it('the ledger keeps a hash of a request, never the funder or the EIN', async () => {
    const ledger = new InMemoryKeyLedger();
    const h = harness({ ledger });
    const entityRef = await approvedEntity(h);
    const { collectionRef } = await h.adapter.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
    await h.adapter.createPaymentPage({ collectionRef, funder: { name: 'Dana Levi', email: 'dana@example.com', mobile: '+12125550123' }, idempotencyKey: 'key-page-0001' });
    for (const k of ['entity:key-entity-0001', 'intent:key-page-0001']) {
      const body = (await ledger.get(k))?.body ?? '';
      expect(body).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('a reused key with another body is a conflict decided before anything is sent', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 100_000n);
    await h.adapter.sendAch(ach(entityRef));
    await h.adapter.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
    const before = h.fake.calls.length;
    await expect(h.adapter.sendAch(ach(entityRef, 'key-ach-00001', 20_000n))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(h.adapter.createCollection({ entityRef, title: 'Other', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.fake.calls).toHaveLength(before);
  });

  it('after a restart the same ACH key reaches the same payment: Crowded dedupes our UUID', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 100_000n);
    const a = await h.adapter.sendAch(ach(entityRef));
    expect(await restarted(h).sendAch(ach(entityRef))).toEqual(a);
    expect(h.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/payments')).map((c) => ((c.body as { data: { payments: { idempotencyKey: string }[] } }).data.payments[0]!.idempotencyKey))).toHaveLength(2);
    expect((await h.adapter.account(entityRef)).balance.minor).toBe(90_000n);
  });

  describe('a 409 DUPLICATE_REQUEST on an ACH create is in flight (T-0695)', () => {
    const creates = (h: Harness) => h.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/payments'));
    const wireKey = (c: { body: unknown }) => (c.body as { data: { payments: { idempotencyKey: string }[] } }).data.payments[0]!.idempotencyKey;
    const withSleep = () => {
      const waits: number[] = [];
      return { waits, sleep: async (ms: number) => void waits.push(ms) };
    };

    it('retries the same key after a wait and returns the payment the first call made: one payment at the fake', async () => {
      const s = withSleep();
      const h = harness({ sleep: s.sleep });
      const entityRef = await approvedEntity(h);
      h.fake.fund(entityRef, 100_000n);
      h.fake.inFlightAchCalls = 2;
      const r = await h.adapter.sendAch(ach(entityRef));
      expect(r.status).toBe('pending');
      expect(s.waits).toEqual([1000, 2000]);
      expect(h.fake.count('payments')).toBe(1);
      expect(new Set(creates(h).map(wireKey)).size).toBe(1);
      expect(creates(h)).toHaveLength(3);
      expect((await h.adapter.account(entityRef)).balance.minor).toBe(90_000n);
      expect(await h.adapter.sendAch(ach(entityRef))).toEqual(r);
    });

    it('a 409 that never clears is OUTCOME_UNKNOWN after 3 retries (waits 1 s, 2 s, 4 s), same key throughout', async () => {
      const s = withSleep();
      const h = harness({ sleep: s.sleep });
      const entityRef = await approvedEntity(h);
      h.fake.fund(entityRef, 100_000n);
      h.fake.inFlightAchCalls = 99;
      const e = await h.adapter.sendAch(ach(entityRef)).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect((e as Error).message).toMatch(/read it back before retrying, and do not resend under a new key/);
      expect(s.waits).toEqual([1000, 2000, 4000]);
      expect(creates(h)).toHaveLength(4);
      expect(new Set(creates(h).map(wireKey)).size).toBe(1);
      expect(h.fake.count('payments')).toBe(1);
    });

    it('a 409 on a payment is never our IDEMPOTENCY_CONFLICT', async () => {
      const s = withSleep();
      const h = harness();
      const entityRef = await approvedEntity(h);
      h.fake.fund(entityRef, 100_000n);
      const b = restarted(h, (url, init) => (init?.method === 'POST' && url.endsWith(`/chapters/${entityRef}/payments`) ? json(409, { message: 'dup', code: 'DUPLICATE_REQUEST' }) : undefined), { sleep: s.sleep });
      const e = await b.sendAch(ach(entityRef)).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect((e as Error).message).toMatch(/read it back/);
    });

    it('a network error or a 5xx is not retried here', async () => {
      const s = withSleep();
      const h = harness();
      const entityRef = await approvedEntity(h);
      h.fake.fund(entityRef, 100_000n);
      let seen = 0;
      const hook = (status: number | 'net') => (url: string, init: RequestInit | undefined) => {
        if (init?.method !== 'POST' || !url.endsWith(`/chapters/${entityRef}/payments`)) return undefined;
        seen++;
        if (status === 'net') throw new TypeError('fetch failed');
        return json(status, { message: 'x' });
      };
      for (const status of [503, 500, 'net'] as const) {
        seen = 0;
        await expect(restarted(h, hook(status), { sleep: s.sleep }).sendAch(ach(entityRef, `key-ach-${status}-0`))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
        expect(seen).toBe(1);
      }
      expect(s.waits).toEqual([]);
    });

    it('an ACH create answering another kind of 409 is not retried', async () => {
      const s = withSleep();
      const h = harness();
      const entityRef = await approvedEntity(h);
      h.fake.fund(entityRef, 100_000n);
      let seen = 0;
      const hook = (url: string, init?: RequestInit): Response | undefined =>
        init?.method === 'POST' && url.endsWith(`/chapters/${entityRef}/payments`) ? (seen++, json(409, { type: 'ResourceConflictError', message: 'The counterparty is being changed' })) : undefined;
      await expect(restarted(h, hook, { sleep: s.sleep }).sendAch(ach(entityRef, 'key-ach-other409'))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(seen).toBe(1);
      expect(s.waits).toEqual([]);
    });

    it('a book transfer does not retry a 409: the fund call keeps its own handling', async () => {
      const s = withSleep();
      const h = harness();
      const { entityRef } = await h.adapter.createEntity({ ...NEW('key-entity-0409', 'Israel Global Pay, LLC'), holder: 'platform' });
      h.fake.decide(entityRef);
      h.fake.fund(entityRef, 100_000n);
      const { subAccountRef } = await h.adapter.createSubAccount({ entityRef, institutionId: 'inst-0001', idempotencyKey: 'key-sub-00001' });
      let seen = 0;
      const b = restarted(h, (url, init) => (init?.method === 'POST' && url.endsWith('/subaccounts/fund') ? (seen++, json(409, { message: 'dup', code: 'DUPLICATE_REQUEST' })) : undefined), { sleep: s.sleep });
      await expect(b.bookTransfer({ fromRef: entityRef, toRef: subAccountRef, amount: money(5_000n, 'USD'), memo: 'KC-1', idempotencyKey: 'key-book-0409' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(seen).toBe(1);
      expect(s.waits).toEqual([]);
    });
  });

  it('an item error or a failed item in a payment answer is REJECTED', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 100_000n);
    for (const item of [{ status: 'failed', error: 'x' }, { status: 'success', paymentStatus: 'Rejected', paymentId: 'p9' }, { error: 'no' }]) {
      const b = restarted(h, (url, init) => (init?.method === 'POST' && url.endsWith(`/chapters/${entityRef}/payments`) ? json(200, { data: { results: [item] } }) : undefined));
      await expect(b.sendAch(ach(entityRef, `key-ach-${JSON.stringify(item).length}`))).rejects.toMatchObject({ code: 'REJECTED' });
    }
  });

  it('a results-shaped payment answer reads the payment status, not the item status', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 100_000n);
    const b = restarted(h, (url, init) => (init?.method === 'POST' && url.endsWith(`/chapters/${entityRef}/payments`) ? json(200, { data: { results: [{ index: 0, status: 'success', paymentId: 'p9', paymentStatus: 'Pending' }] } }) : undefined));
    expect(await b.sendAch(ach(entityRef))).toEqual({ paymentRef: `${entityRef}:p9`, status: 'pending' });
  });

  it('a funding answer we cannot read is an unknown outcome; a failed item is refused; a retry after a restart funds once', async () => {
    const h = harness();
    const platform = await h.adapter.createEntity({ ...NEW('key-entity-0009', 'Israel Global Pay, LLC'), holder: 'platform' });
    h.fake.decide(platform.entityRef);
    h.fake.fund(platform.entityRef, 500_000n);
    const sub = await h.adapter.createSubAccount({ entityRef: platform.entityRef, institutionId: '0190a0a0-0000-7000-8000-000000000101', idempotencyKey: 'key-sub-00001' });
    const move = { fromRef: platform.entityRef, toRef: sub.subAccountRef, amount: money(1_000n, 'USD'), memo: 'KC-7M4QX2HD' };
    const fund = (url: string, init: RequestInit | undefined) => init?.method === 'POST' && url.endsWith('/subaccounts/fund');
    await expect(restarted(h, (u, i) => (fund(u, i) ? json(200, { data: {} }) : undefined)).bookTransfer({ ...move, idempotencyKey: 'key-book-0001' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(restarted(h, (u, i) => (fund(u, i) ? json(200, { data: [{ id: 'x', status: 'failed', error: 'no' }] }) : undefined)).bookTransfer({ ...move, idempotencyKey: 'key-book-0002' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await h.adapter.bookTransfer({ ...move, idempotencyKey: 'key-book-0003' });
    await restarted(h).bookTransfer({ ...move, idempotencyKey: 'key-book-0003' });
    expect((await h.adapter.account(sub.subAccountRef)).balance.minor).toBe(1_000n);
  });

  it('a payment cancelled by someone else between our read and our call is cancelled, not refused', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    h.fake.fund(entityRef, 100_000n);
    const a = await h.adapter.sendAch(ach(entityRef));
    let raced = false;
    const b = restarted(h, async (url, init) => {
      if (!raced && init?.method === 'POST' && url.endsWith('/cancel')) {
        raced = true;
        await h.fake.fetch(url, init); // someone else cancels first
      }
      return undefined;
    });
    expect(await b.cancelAch(a.paymentRef)).toBe('cancelled');
  });

  it('an account in another currency is refused', async () => {
    const h = harness();
    const entityRef = await approvedEntity(h);
    const b = restarted(h, (url) => (url.includes('/accounts') ? json(200, { data: [{ id: 'a1', status: 'Open', accountNumber: '000123456789', currency: 'ILS', balance: '100' }], meta: { pagination: { total: 1 } } }) : undefined));
    await expect(b.account(entityRef)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

// ---- sub-account create with an unknown outcome (T-0696) ----------------------------------------------------------------

describe('createSubAccount looks a sub-account up by name (T-0696)', () => {
  const INST = '0190a0a0-0000-7000-8000-000000000101';
  const NAME = `Institution ${INST}`;
  const sub = (entityRef: string, key = 'key-sub-00001', institutionId = INST) => ({ entityRef, institutionId, idempotencyKey: key });
  const platformEntity = async (h: Harness, key = 'key-entity-0009', institutionId = '0190a0a0-0000-7000-8000-000000000001') => {
    const { entityRef } = await h.adapter.createEntity({ ...NEW(key, 'Israel Global Pay, LLC'), holder: 'platform', institutionId });
    h.fake.decide(entityRef);
    return entityRef;
  };
  const subPosts = (h: Harness) => h.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/subaccounts'));
  /** The create reaches the fake (the sub-account exists) but its answer is lost; the wire stays down until `up()`. */
  const lostAnswer = (h: Harness, how: 'http500' | 'network') => {
    let down = false;
    const hook = async (url: string, init: RequestInit | undefined): Promise<Response | undefined> => {
      if (init?.method === 'POST' && url.endsWith('/subaccounts')) {
        await h.fake.fetch(url, init);
        down = true;
      }
      if (!down) return undefined;
      if (how === 'network') throw new TypeError('fetch failed');
      return json(503, { message: 'Unavailable' });
    };
    return { hook, up: () => void (down = false) };
  };

  it.each(['http500', 'network'] as const)('an unknown outcome (%s) then the same key again finds the sub-account and makes no second one', async (how) => {
    const h = harness();
    const entityRef = await platformEntity(h);
    const lost = lostAnswer(h, how);
    const a = restarted(h, lost.hook);
    await expect(a.createSubAccount(sub(entityRef))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.subAccountCount()).toBe(1);
    lost.up();
    const found = await a.createSubAccount(sub(entityRef));
    expect(h.fake.subAccountCount()).toBe(1);
    expect(subPosts(h)).toHaveLength(1);
    expect(found).toEqual({ subAccountRef: expect.stringMatching(/^ch/), hasOwnAccountNumber: true });
    // The same answer again, from the ledger now, and a restarted process finds the same one.
    expect(await a.createSubAccount(sub(entityRef))).toEqual(found);
    expect(await restarted(h).createSubAccount(sub(entityRef))).toEqual(found);
    expect(h.fake.names('chapters').filter((n) => n === NAME)).toHaveLength(1);
  });

  it('a post that ends unknown is followed by a lookup, and the first call already answers the sub-account', async () => {
    const h = harness();
    const entityRef = await platformEntity(h);
    const a = restarted(h, async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/subaccounts')) {
        await h.fake.fetch(url, init);
        return json(500, { type: 'InternalServerErrorException', message: 'boom' });
      }
      return undefined;
    });
    const r = await a.createSubAccount(sub(entityRef));
    expect(h.fake.subAccountCount()).toBe(1);
    expect(subPosts(h)).toHaveLength(1);
    expect(h.fake.names('chapters')).toContain(NAME);
    expect(r.subAccountRef).toMatch(/^ch/);
  });

  it('a clean first create posts once, after one lookup that found nothing', async () => {
    const h = harness();
    const entityRef = await platformEntity(h);
    const r = await h.adapter.createSubAccount(sub(entityRef));
    expect(subPosts(h)).toHaveLength(1);
    expect(h.fake.calls.filter((c) => c.method === 'GET' && c.path === '/chapters' && c.query['search'] === NAME)).toHaveLength(1);
    expect(await h.adapter.createSubAccount(sub(entityRef))).toEqual(r);
    expect(subPosts(h)).toHaveLength(1);
  });

  it('the live shape: the same key twice at the fake answers 500, and the list finds a sub-account by search', async () => {
    const h = harness();
    const entityRef = await platformEntity(h);
    const body = { data: { name: NAME, email: 'ops@kesher.example', idempotencyKey: '0190a0a0-0000-4000-8000-0000000000aa' } };
    const post = () => h.fake.fetch(`${BASE}/chapters/${entityRef}/subaccounts`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(500);
    const list = await h.fake.fetch(`${BASE}/chapters?search=${encodeURIComponent(NAME)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(((await list.json()) as { data: { name: string }[] }).data.map((c) => c.name)).toEqual([NAME]);
  });

  it('a name match claimed by another key is not reused: VALIDATION_FAILED, and nothing is posted', async () => {
    const h = harness();
    const entityRef = await platformEntity(h);
    const ledger = new InMemoryKeyLedger();
    const one = restarted(h, undefined, { ledger });
    await one.createSubAccount(sub(entityRef, 'key-sub-00001'));
    // Another key, the same ledger (so the claim is known): the existing sub-account is not handed to it.
    await expect(restarted(h, undefined, { ledger }).createSubAccount(sub(entityRef, 'key-sub-00002'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(subPosts(h)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(1);
  });

  it.each([false, true])('a same-named chapter under another parent is not reused (the list shows the parent: %s)', async (shows) => {
    const h = harness();
    h.fake.listShowsParent = shows;
    const a = await platformEntity(h, 'key-entity-000a', '0190a0a0-0000-7000-8000-00000000000a');
    const b = await platformEntity(h, 'key-entity-000b', '0190a0a0-0000-7000-8000-00000000000b');
    const underA = await h.adapter.createSubAccount(sub(a, 'key-sub-0000a'));
    const underB = await restarted(h).createSubAccount(sub(b, 'key-sub-0000b'));
    expect(underB.subAccountRef).not.toBe(underA.subAccountRef);
    expect(h.fake.subAccountCount()).toBe(2);
    // And each parent still finds its own after a restart.
    expect(await restarted(h).createSubAccount(sub(a, 'key-sub-0000a'))).toEqual(underA);
    expect(await restarted(h).createSubAccount(sub(b, 'key-sub-0000b'))).toEqual(underB);
    expect(h.fake.subAccountCount()).toBe(2);
  });

  it('a 429 quota answer is surfaced as a quota error, posts once, and is not retried or looped', async () => {
    const h = harness();
    const entityRef = await platformEntity(h);
    h.fake.subAccountQuota = 0;
    const err = await h.adapter.createSubAccount(sub(entityRef)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: expect.stringMatching(/quota/i) });
    expect(subPosts(h)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(0);
    // Quota lifted: the same key now creates it.
    h.fake.subAccountQuota = undefined;
    await h.adapter.createSubAccount(sub(entityRef));
    expect(h.fake.subAccountCount()).toBe(1);
  });
});

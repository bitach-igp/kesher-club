// CrowdedInstitutionBankingAdapter passes institutionBankingContract against the in-memory FakeCrowded, for an
// institution's own entity and for the platform's (T-0648, REQ-INS-022, REQ-INS-024). Crowded has no per-account pooled
// mode in its docs, so the pooled setup is not run here. A real-sandbox run needs a human to approve the bank
// application, so sandbox.test.ts is a read-only smoke test (skipped without CROWDED_SANDBOX_TOKEN).
import { describe, expect, it, vi } from 'vitest';
import { money } from '@kesher/domain';
import { institutionBankingContract } from '@kesher/ports/contracts';
import { CrowdedClient } from './client.ts';
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

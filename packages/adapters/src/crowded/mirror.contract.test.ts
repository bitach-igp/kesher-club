// CrowdedMirror passes the MirrorPort contract against FakeCrowded and pins what Crowded adds (T-0719, TST-WAL-003, TST-LED-003,
// REQ-WAL-002, REQ-LED-004): one HTTP request per batch, a failed item mapped by its errorCode, a Rejected item (HTTP 201) a refusal,
// DUPLICATE_PAYMENT read back never booked twice, v4 wire keys scoped to the chapter, read-back by memo, feeds read whole, bigint to
// 2^53 and past. All names, emails and mobiles are made up (example.test, 555 numbers).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { MirrorError, type MirrorBalance, type MirrorLeg, type MirrorLegResult, type MirrorMovement, type MirrorPayment, type MirrorPort, type MirrorReadBack } from '@kesher/ports';
import { mirrorContract } from '@kesher/ports/contracts';
import { bookWireKey } from './book.ts';
import { CrowdedClient } from './client.ts';
import { FakeCrowded } from './fake-crowded.ts';
import { CrowdedMirror } from './mirror.ts';

const TOKEN = 'crowded_test_token_not_a_secret';
const BASE = 'https://sandbox.fake.invalid/api/v1';
type Fetch = typeof globalThis.fetch;

/** Lets a test change what the vendor answers (after the fake processed the request) or fail a request. */
interface Tap {
  after?: (method: string, path: string, res: Response) => Promise<Response> | Response;
  before?: (method: string, path: string) => Response | undefined;
}

function harness(over: { pageSize?: number } = {}) {
  const fake = new FakeCrowded({ token: TOKEN, pageSize: over.pageSize ?? 2 });
  const chapterId = fake.seedChapter();
  const tap: Tap = {};
  const fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    const early = tap.before?.(method, path);
    if (early) return early;
    const res = await fake.fetch(input, init);
    return tap.after ? tap.after(method, path, res) : res;
  };
  const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch });
  const mirror = new CrowdedMirror({ client, chapterId });
  const aliases = new Map<string, string>();
  let n = 0;
  /** A contact and a wallet account in `chapter` holding `minor`; the alias is the name the contract uses for its ref. */
  const wallet = async (alias: string, minor: bigint, chapter = chapterId): Promise<string> => {
    const mobile = `+1415555${String(1000 + ++n)}`;
    const c = await client.post(`/chapters/${chapter}/contacts`, [{ firstName: 'Test', lastName: `Member${n}`, mobile, email: `m${n}@example.test` }]);
    const contactId = (c.data as { id: number }[])[0]!.id;
    const a = await client.post(`/chapters/${chapter}/accounts`, { items: [{ contactId, product: 'wallet' }], idempotencyKey: bookWireKey(`wallet-${chapter}-${n}`) });
    const id = String((a.data as { results: { accountId: number }[] }).results[0]!.accountId);
    fake.setBalance(Number(id), minor);
    aliases.set(alias, `a:${id}`);
    return `a:${id}`;
  };
  return { fake, chapterId, mirror, client, tap, aliases, wallet };
}
type H = ReturnType<typeof harness>;

/** The contract names accounts `acct_m1`; the adapter takes `a:<id>`. This maps both ways around the adapter and nothing else. */
class AliasedMirror implements MirrorPort {
  readonly h: H;
  constructor(h: H) {
    this.h = h;
  }
  private to = (ref: string): string => this.h.aliases.get(ref) ?? 'a:999999';
  private from = (ref: string): string => [...this.h.aliases.entries()].find(([, v]) => v === ref)?.[0] ?? ref;
  private leg<T extends { accountRef: string }>(l: T): T {
    return { ...l, accountRef: this.from(l.accountRef) };
  }
  private result(r: MirrorLegResult): MirrorLegResult {
    return { ...r, ...(r.leg ? { leg: this.leg(r.leg) } : {}) };
  }
  async bookBatch(legs: MirrorLeg[], chapterRef: string): Promise<MirrorLegResult[]> {
    return (await this.h.mirror.bookBatch(legs.map((l) => ({ ...l, accountRef: l.accountRef === '' ? '' : this.to(l.accountRef) })), chapterRef)).map((r) => this.result(r));
  }
  async readBack(input: Parameters<MirrorPort['readBack']>[0]): Promise<MirrorReadBack> {
    const r = await this.h.mirror.readBack({ ...input, ...(input.accountRef ? { accountRef: this.to(input.accountRef) } : {}) });
    if (r.status === 'found') return { status: 'found', result: this.result(r.result) };
    if (r.status === 'ambiguous') return { status: 'ambiguous', candidates: r.candidates.map((c) => this.result(c)) };
    return r;
  }
  checkingBalance(chapterRef: string): Promise<MirrorBalance> {
    return this.h.mirror.checkingBalance(chapterRef);
  }
  accountBalance(accountRef: string): Promise<MirrorBalance> {
    return this.h.mirror.accountBalance(this.to(accountRef));
  }
  async *payments(input: Parameters<MirrorPort['payments']>[0]): AsyncIterable<MirrorPayment> {
    for await (const p of this.h.mirror.payments(input)) yield { ...p, sourceAccountRef: this.from(p.sourceAccountRef), destinationAccountRef: this.from(p.destinationAccountRef) };
  }
  async *movements(input: { from: Date; to: Date }): AsyncIterable<MirrorMovement> {
    for await (const m of this.h.mirror.movements(input)) yield { ...m, accountRef: this.from(m.accountRef), ...(m.counterpartyAccountRef ? { counterpartyAccountRef: this.from(m.counterpartyAccountRef) } : {}) };
  }
}

const worlds = new WeakMap<object, H>();
const make = (): AliasedMirror => {
  const h = harness();
  const p = new AliasedMirror(h);
  worlds.set(p, h);
  return p;
};
const w = (p: object): H => worlds.get(p)!;
const walletNo = (h: H, alias: string): number => Number(h.aliases.get(alias)!.slice(2));

// A fresh fake numbers its first chapter the same way every time, so the contract can name it up front.
const CHAPTER = new FakeCrowded({ token: TOKEN }).seedChapter();
const wire = (key: string): string => bookWireKey(key);

mirrorContract('crowded mirror (fake)', make, {
  chapterRef: CHAPTER,
  seed: async (p, { accountRef, accountMinor, checkingMinor }) => {
    const h = w(p);
    await h.wallet(accountRef, accountMinor);
    h.fake.setChecking(h.chapterId, checkingMinor);
  },
  refuse: (p, key, code) => w(p).fake.refuseBook(wire(key), code),
  vendorStatus: (p, key, status) => w(p).fake.bookStatus(wire(key), status),
  loseAnswer: (p, key) => w(p).fake.loseBookAnswer(wire(key)),
  loseBatch: (p) => w(p).fake.loseNextResponse(),
  setStatus: (p, ref, status) => w(p).fake.setAccountStatus(walletNo(w(p), ref), status === 'open' ? 'Open' : status === 'frozen' ? 'Frozen' : 'Closed'),
  outage: (p, on) => void (w(p).fake.rateLimited = on),
});

// ---- what Crowded adds -------------------------------------------------------------------------------------------------

const leg = (key: string, ref: string, over: Partial<MirrorLeg> = {}): MirrorLeg => ({ direction: 'from_checking', accountRef: ref, amount: money(2_500n, 'USD'), memo: `KC-${key}`, idempotencyKey: key, ...over });
const posts = (h: H) => h.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/payments'));
const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function setup(member = 10_000n, checking = 10_000n) {
  const h = harness();
  const ref = await h.wallet('m1', member);
  h.fake.setChecking(h.chapterId, checking);
  return { h, ref, bal: async () => (await h.mirror.accountBalance(ref)).balance };
}

describe('CrowdedMirror over the fake (T-0719)', () => {
  it('three legs are one request with three items; a failed item INSUFFICIENT_FUNDS refuses its own leg, the others book once', async () => {
    const { h, ref, bal } = await setup();
    h.fake.refuseBook(wire('key-leg-0002'), 'INSUFFICIENT_FUNDS');
    const legs = [leg('key-leg-0001', ref), leg('key-leg-0002', ref), leg('key-leg-0003', ref)];
    const res = await h.mirror.bookBatch(legs, h.chapterId);
    expect(posts(h)).toHaveLength(1);
    expect((posts(h)[0]!.body as { data: { payments: unknown[] } }).data.payments).toHaveLength(3);
    expect(res.map((r) => [r.status, r.reasonCode])).toEqual([['booked', undefined], ['refused', 'INSUFFICIENT_FUNDS'], ['booked', undefined]]);
    expect(await bal()).toBe(15_000n);
    expect(h.fake.bookPaymentIds(h.chapterId).filter((p) => p.status === 'sent')).toHaveLength(2);
  });

  it('an item Rejected (HTTP 201, item status success) is refused with its reason; with no reason it is PAYMENT_FAILED', async () => {
    const { h, ref, bal } = await setup();
    const [a] = await h.mirror.bookBatch([leg('key-leg-0001', ref, { amount: money(99_999n, 'USD') })], h.chapterId);
    expect(a).toMatchObject({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
    expect(a?.paymentRef).toBeTruthy();
    h.tap.after = async (method, _path, res) => {
      if (method !== 'POST') return res;
      const b = (await res.json()) as { data: { results: Record<string, unknown>[] } };
      for (const r of b.data.results) delete r['reasonCode'];
      return json(201, b);
    };
    const [b] = await h.mirror.bookBatch([leg('key-leg-0002', ref, { amount: money(99_999n, 'USD') })], h.chapterId);
    expect(b).toMatchObject({ status: 'refused', reasonCode: 'PAYMENT_FAILED' });
    expect(await bal()).toBe(10_000n);
  });

  it('a failed item is mapped by its errorCode: ACCOUNT_UNAVAILABLE, NOT_FOUND, and an unknown code is PAYMENT_FAILED', async () => {
    const { h, ref } = await setup();
    h.fake.setAccountStatus(Number(ref.slice(2)), 'Frozen');
    const [frozen] = await h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId);
    expect(frozen).toMatchObject({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
    expect(frozen?.paymentRef).toBeUndefined();
    const [nope] = await h.mirror.bookBatch([leg('key-leg-0002', 'a:987654')], h.chapterId);
    expect(nope).toMatchObject({ status: 'refused', reasonCode: 'NOT_FOUND' });
    h.fake.setAccountStatus(Number(ref.slice(2)), 'Open');
    h.fake.refuseBook(wire('key-leg-0003'), 'SOMETHING_NEW');
    const [odd] = await h.mirror.bookBatch([leg('key-leg-0003', ref)], h.chapterId);
    expect(odd).toMatchObject({ status: 'refused', reasonCode: 'PAYMENT_FAILED' });
  });

  it('DUPLICATE_PAYMENT is read back and answered booked with the first payment, never a second movement', async () => {
    const { h, ref, bal } = await setup();
    h.fake.duplicateKeys = 'error';
    const [first] = await h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId);
    const [again] = await h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId);
    expect(again).toEqual(first);
    expect(again?.paymentRef).toBeTruthy();
    expect(await bal()).toBe(12_500n);
    expect(h.fake.bookPaymentIds(h.chapterId)).toHaveLength(1);
    // A reused key whose memo is not the first one cannot be read back by it: unknown, never booked or refused.
    const [odd] = await h.mirror.bookBatch([leg('key-leg-0001', ref, { memo: 'KC-other-memo' })], h.chapterId);
    expect(odd?.status).toBe('unknown');
    expect(await bal()).toBe(12_500n);
  });

  it('an answer whose shape is unknown, or lost after the request was sent, is OUTCOME_UNKNOWN and readBack finds the payment', async () => {
    const { h, ref, bal } = await setup();
    h.tap.after = (method, _path, res) => (method === 'POST' ? json(200, { data: { surprise: true } }) : res);
    await expect(h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    delete h.tap.after;
    expect(await h.mirror.readBack({ chapterRef: h.chapterId, memo: 'KC-key-leg-0001', accountRef: ref, direction: 'from_checking', amount: money(2_500n, 'USD') })).toMatchObject({ status: 'found', result: { status: 'booked', leg: { accountRef: ref, amount: money(2_500n, 'USD') } } });
    h.tap.after = (method, _path, res) => (method === 'POST' ? json(503, { message: 'Unavailable' }) : res);
    await expect(h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    delete h.tap.after;
    const [resent] = await h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId);
    expect(resent?.status).toBe('booked');
    expect(await bal()).toBe(12_500n);
  });

  it('a 429 or an auth refusal never left (PROVIDER_UNAVAILABLE); a 400 is the whole request refused; no vendor text reaches an error', async () => {
    const { h, ref } = await setup();
    h.tap.before = (method, path) => (method === 'POST' && path.endsWith('/payments') ? json(429, { message: 'slow down' }) : undefined);
    await expect(h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    h.tap.before = (method, path) => (method === 'POST' && path.endsWith('/payments') ? json(400, { message: 'Bad mobile +14155550123 for sarah.cohen@example.test' }) : undefined);
    const err = await h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MirrorError);
    expect((err as MirrorError).code).toBe('VALIDATION_FAILED');
    expect((err as MirrorError).message).not.toMatch(/\d{5}|@|sarah/i);
    h.tap.before = () => json(503, { message: 'Account 000123456789 is down' });
    const read = await h.mirror.readBack({ chapterRef: h.chapterId, memo: 'KC-x' }).catch((e: unknown) => e);
    expect((read as MirrorError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((read as MirrorError).message).not.toMatch(/\d{5}/);
  });

  it('sends our memo as the description and nothing else of the leg; keys are v4 UUIDs, stable per key, and scoped to the chapter', async () => {
    const { h, ref } = await setup();
    const memo = `KC-${'x'.repeat(77)}`;
    await h.mirror.bookBatch([leg('key-leg-0001', ref, { memo })], h.chapterId);
    const item = (posts(h)[0]!.body as { data: { type: string; payments: Record<string, unknown>[] } }).data;
    expect(item.type).toBe('book');
    expect(Object.keys(item.payments[0]!).sort()).toEqual(['amount', 'description', 'destinationAccountId', 'idempotencyKey', 'sourceAccountId']);
    expect(item.payments[0]!['description']).toBe(memo);
    expect(item.payments[0]!['description'] as string).toHaveLength(80);
    expect(item.payments[0]!['idempotencyKey']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(item.payments[0]!['idempotencyKey']).toBe(wire('key-leg-0001'));
    expect(wire('key-leg-0001')).not.toBe(wire('key-leg-0002'));
    // The same key in another chapter is another payment (the fake keeps keys per chapter, as Crowded does).
    const ch2 = h.fake.seedChapter('Second');
    const ref2 = await h.wallet('m2', 0n, ch2);
    h.fake.setChecking(ch2, 5_000n);
    const [other] = await h.mirror.bookBatch([leg('key-leg-0001', ref2, { memo })], ch2);
    expect(other?.status).toBe('booked');
    expect(h.fake.bookPaymentIds(h.chapterId)).toHaveLength(1);
    expect(h.fake.bookPaymentIds(ch2)).toHaveLength(1);
  });

  it('refuses a leg the wire cannot carry, or whose account is no wallet ref, without any request; a bigint balance past 2^53 stays exact', async () => {
    const big = 9_007_199_254_740_993n;
    const { h, ref, bal } = await setup(big, big);
    const res = await h.mirror.bookBatch([leg('key-leg-0001', ref, { amount: money(big, 'USD') }), leg('key-leg-0002', 'c:7')], h.chapterId);
    expect(res.map((r) => [r.status, r.reasonCode])).toEqual([['refused', 'VALIDATION_ERROR'], ['refused', 'NOT_FOUND']]);
    expect(posts(h)).toHaveLength(0);
    expect(await bal()).toBe(big);
    await h.mirror.bookBatch([leg('key-leg-0003', ref, { amount: money(2n, 'USD') })], h.chapterId);
    expect(await bal()).toBe(big + 2n);
    expect((await h.mirror.checkingBalance(h.chapterId)).balance).toBe(big - 2n);
  });

  it('a booked item whose stored leg cannot be read is unknown, not booked; the money moved once', async () => {
    const { h, ref, bal } = await setup();
    h.tap.before = (method, path) => (method === 'GET' && /\/payments\/bp\d+$/.test(path) ? json(503, {}) : undefined);
    const [r] = await h.mirror.bookBatch([leg('key-leg-0001', ref)], h.chapterId);
    expect(r?.status).toBe('unknown');
    expect(r?.paymentRef).toBeTruthy();
    delete h.tap.before;
    expect(await h.mirror.readBack({ chapterRef: h.chapterId, memo: 'KC-key-leg-0001' })).toMatchObject({ status: 'found', result: { status: 'booked', paymentRef: r?.paymentRef } });
    expect(await bal()).toBe(12_500n);
  });

  it('a read-back of a failed payment takes the reason the row carries, else PAYMENT_FAILED', async () => {
    const { h, ref } = await setup();
    await h.mirror.bookBatch([leg('key-leg-0001', ref, { amount: money(99_999n, 'USD') })], h.chapterId);
    expect(await h.mirror.readBack({ chapterRef: h.chapterId, memo: 'KC-key-leg-0001' })).toMatchObject({ status: 'found', result: { status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' } });
    h.tap.after = async (method, _path, res) => {
      if (method !== 'GET') return res;
      const text = (await res.text()).replaceAll('"reasonCode":"InsufficientFunds",', '');
      return new Response(text, { status: res.status, headers: res.headers });
    };
    expect(await h.mirror.readBack({ chapterRef: h.chapterId, memo: 'KC-key-leg-0001' })).toMatchObject({ status: 'found', result: { status: 'refused', reasonCode: 'PAYMENT_FAILED' } });
  });

  it('movements read the transactions feed, keep bookTransaction rows, two per payment, and a later-page outage throws with nothing yielded', async () => {
    const { h, ref } = await setup();
    await h.mirror.bookBatch([leg('key-leg-0001', ref), leg('key-leg-0002', ref, { direction: 'to_checking', amount: money(500n, 'USD') }), leg('key-leg-0003', ref)], h.chapterId);
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2027-01-01T00:00:00Z');
    const rows = await collect(h.mirror.movements({ from, to }));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.transactionRef)).size).toBe(6);
    expect(rows.filter((r) => r.accountRef === h.chapterId).every((r) => r.counterpartyAccountRef === ref)).toBe(true);
    expect(h.fake.calls.some((c) => c.path === `/chapters/${h.chapterId}/transactions`)).toBe(true);
    expect(h.fake.calls.find((c) => c.path.endsWith('/transactions'))!.query['filter[createdAt][min]']).toBe(from.toISOString());
    expect(await collect(h.mirror.movements({ from: to, to: new Date('2028-01-01T00:00:00Z') }))).toEqual([]);
    let pages = 0;
    h.tap.before = (method, path) => (method === 'GET' && path.endsWith('/transactions') && ++pages === 3 ? json(503, {}) : undefined);
    const yielded: MirrorMovement[] = [];
    await expect(
      (async () => {
        for await (const m of h.mirror.movements({ from, to })) yielded.push(m);
      })(),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(yielded).toEqual([]);
  });

  it('balances are { status, balance, hold, available }; hold is kept apart and an unknown status reads frozen', async () => {
    const { h, ref } = await setup(1_000n);
    h.fake.holdWallet(Number(ref.slice(2)), 300n);
    expect(await h.mirror.accountBalance(ref)).toEqual({ status: 'open', balance: 1_000n, hold: 300n, available: 700n });
    h.tap.after = async (_m, path, res) => (/\/accounts\/\d+$/.test(path) ? json(200, { data: { ...((await res.json()) as { data: object }).data, status: 'Blocked' } }) : res);
    expect(await h.mirror.accountBalance(ref)).toMatchObject({ status: 'frozen' });
    await expect(h.mirror.accountBalance('c:7')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('payments lists each book payment once, oldest first, across pages, and a later-page outage throws with nothing yielded', async () => {
    const { h, ref } = await setup();
    await h.mirror.bookBatch(Array.from({ length: 5 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, ref, { amount: money(BigInt(100 + i), 'USD') })), h.chapterId);
    const rows = await collect(h.mirror.payments({ chapterRef: h.chapterId, from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') }));
    expect(rows.map((r) => r.memo)).toEqual([0, 1, 2, 3, 4].map((i) => `KC-key-leg-${String(i).padStart(4, '0')}`));
    expect(rows[0]).toMatchObject({ sourceAccountRef: h.chapterId, destinationAccountRef: ref, status: 'sent' });
    let pages = 0;
    h.tap.before = (method, path) => (method === 'GET' && path.endsWith('/payments') && ++pages === 2 ? json(503, {}) : undefined);
    const yielded: MirrorPayment[] = [];
    await expect(
      (async () => {
        for await (const p of h.mirror.payments({ chapterRef: h.chapterId, from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') })) yielded.push(p);
      })(),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(yielded).toEqual([]);
  });

  it('needs a chapter id and answers NOT_FOUND for an unusable chapter ref', async () => {
    const { h } = await setup();
    expect(() => new CrowdedMirror({ client: h.client, chapterId: '' })).toThrow();
    await expect(h.mirror.checkingBalance('../x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.mirror.checkingBalance('ch999999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

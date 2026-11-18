// CrowdedMemberSubAccounts passes memberSubAccountContract against FakeCrowded, and pins what Crowded adds (T-0754, TST-WAL-002,
// REQ-INS-022): one sub-account per member and purpose, an orphan found by its name before a create, a create that ends unknown is found and
// not posted again, strict UUID v4 wire keys, the tier limit as QUOTA_EXCEEDED with no retry, an owner object only when given, and no account
// or routing number anywhere. All names, emails and mobiles are made up (example.test, 555 numbers). No live call.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { MemberSubAccountError, isMemberSubAccountPort, type EnsureSubAccountInput, type SubAccountOwner } from '@kesher/ports';
import { memberSubAccountContract } from '@kesher/ports/contracts';
import { CrowdedClient } from './client.ts';
import { FakeCrowded } from './fake-crowded.ts';
import { CrowdedMemberSubAccounts } from './member-sub-accounts.ts';
import { InMemoryKeyLedger, type KeyLedger } from './institution-banking.ts';
import { parseSubAccountRef, subAccountRef } from './map.ts';

const TOKEN = 'crowded_test_token_not_a_secret';
const BASE = 'https://sandbox.fake.invalid/api/v1';
const MAC_KEY = 'test-only-mac-key-not-a-secret-0123456789';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTING = '084106768';

interface HarnessOptions {
  fake?: FakeCrowded;
  ledger?: KeyLedger;
  parent?: string;
  pageSize?: number;
  /** Wraps the fake's fetch (to lose or spoil an answer after the fake processed the request). */
  wrap?: (inner: typeof globalThis.fetch) => typeof globalThis.fetch;
}

function harness(over: HarnessOptions = {}) {
  const fake = over.fake ?? new FakeCrowded({ token: TOKEN, pageSize: over.pageSize ?? 2 });
  const parent = over.parent ?? fake.seedChapter('Nonprofit');
  const ledger = over.ledger ?? new InMemoryKeyLedger();
  const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: over.wrap ? over.wrap(fake.fetch) : fake.fetch });
  const adapter = new CrowdedMemberSubAccounts({ client, parentChapterId: parent, hmacKey: MAC_KEY, ledger });
  return { fake, adapter, parent, ledger, client };
}

const world = new WeakMap<object, ReturnType<typeof harness>>();
const make = () => {
  const h = harness();
  world.set(h.adapter, h);
  return h.adapter;
};
const w = (p: object) => world.get(p)!;
const chapterOf = (ref: string): string => ref.split(':')[1]!;

memberSubAccountContract('crowded member sub-accounts (fake)', make, {
  ownerFailEmail: 'ownerfail@example.test',
  frozenEmail: 'frozen@example.test',
  outageEmail: 'outage@example.test',
  controls: {
    setQuota: (p, n) => void (w(p).fake.subAccountQuota = n),
    credit: (p, ref, amount) => w(p).fake.fund(chapterOf(ref), amount.minor),
    hold: (p, ref, amount) => w(p).fake.holdSubAccount(chapterOf(ref), amount.minor),
    setStatus: (p, ref, status) => w(p).fake.setSubAccountStatus(chapterOf(ref), status === 'open' ? 'Open' : status === 'frozen' ? 'Frozen' : 'Closed'),
  },
});

const OWNER: SubAccountOwner = { firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', mobile: '+14155550123', dateOfBirth: '1991-04-17' };
const PURPOSE = 'Youth group fundraiser';
const withOwner = (partyId: string, over: Partial<SubAccountOwner> = {}, purpose = PURPOSE): EnsureSubAccountInput => ({ partyId, purpose, owner: { ...OWNER, ...over } });
const invite = (partyId: string, inviteEmail = 'invitee@example.test'): EnsureSubAccountInput => ({ partyId, purpose: PURPOSE, inviteEmail });
const posts = (fake: FakeCrowded) => fake.calls.filter((c) => c.method === 'POST' && /\/subaccounts$/.test(c.path));
const searches = (fake: FakeCrowded) => fake.calls.filter((c) => c.method === 'GET' && c.path === '/chapters' && c.query['search'] !== undefined);
const sent = (call: { body: unknown } | undefined) => ((call?.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>;
const attempt = (p: Promise<unknown>) => p.then((v) => v, (e: unknown) => e);

/** A fetch that lets the fake process a sub-account create and then loses the answer (`'network'`) or spoils it (`500`). */
const losing = (how: 'network' | 409 | 500) => (inner: typeof globalThis.fetch): typeof globalThis.fetch => {
  let armed = true;
  return async (input, init) => {
    const res = await inner(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (armed && (init?.method ?? 'GET') === 'POST' && /\/subaccounts$/.test(url)) {
      armed = false;
      if (how === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ message: 'Internal server error' }), { status: how });
    }
    return res;
  };
};

describe('CrowdedMemberSubAccounts over the fake (T-0754)', () => {
  it('is found by the method-exists guard', () => {
    expect(isMemberSubAccountPort(make())).toBe(true);
  });

  it('two calls with one party make one sub-account at the vendor, named Member {partyId}, and post once', async () => {
    const h = harness();
    const a = await h.adapter.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
    const b = await h.adapter.ensureSubAccount(withOwner('p-1'), 'ensure-key-0002');
    expect(b).toEqual(a);
    expect(h.fake.subAccountCount()).toBe(1);
    expect(posts(h.fake)).toHaveLength(1);
    expect(h.fake.names('chapters')).toContain('Member p-1');
    expect(a.subAccountRef).toBe(subAccountRef(chapterOf(a.subAccountRef)));
    expect(a.accountRef.startsWith(`${a.subAccountRef}:`)).toBe(true);
  });

  it('refs: s:<chapter> and s:<chapter>:<account> are made and parsed by one helper, and nothing else passes', () => {
    expect(parseSubAccountRef('s:ch000001')).toEqual({ chapterId: 'ch000001' });
    expect(parseSubAccountRef('s:ch000001:acct000002')).toEqual({ chapterId: 'ch000001', accountId: 'acct000002' });
    for (const bad of ['', 'c:ch1', 'a:1', 's:', 's::x', 's:a:b:c', 's:../x', 's:a b', 's:a:', 's:a\n', `s:${'x'.repeat(65)}`, undefined, 7]) expect(parseSubAccountRef(bad), String(bad)).toBeUndefined();
  });

  it('a create that ends unknown after the vendor made it (network error) is found by name and not posted again', async () => {
    const h = harness({ wrap: losing('network') });
    const a = await h.adapter.ensureSubAccount(withOwner('p-1'), 'lost-key-0001');
    expect(posts(h.fake)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(1);
    expect(a).toMatchObject({ status: 'open', ownerStatus: 'active' });
    expect(await h.adapter.ensureSubAccount(withOwner('p-1'), 'lost-key-0001')).toEqual(a);
    expect(posts(h.fake)).toHaveLength(1);
  });

  it('a create that ends in a 5xx after the vendor made it is found by name and not posted again (the live replay answers 500)', async () => {
    const h = harness({ wrap: losing(500) });
    const a = await h.adapter.ensureSubAccount(invite('p-1'), 'lost-key-0002');
    expect(posts(h.fake)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(1);
    expect(a.ownerStatus).toBe('invited');
  });

  it('a create that ends in a 409 after the vendor made it is found by name: that one is returned and no duplicate is made', async () => {
    const h = harness({ wrap: losing(409) });
    const a = await h.adapter.ensureSubAccount(withOwner('p-1'), 'lost-key-0003');
    expect(posts(h.fake)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(1);
    expect(h.fake.names('chapters').filter((n) => n === 'Member p-1')).toHaveLength(1);
    expect(a.subAccountRef).toMatch(/^s:/);
  });

  it('a reused key whose create never reached the vendor is IDEMPOTENCY_CONFLICT with no POST (no quota probe)', async () => {
    const h = harness();
    await h.adapter.ensureSubAccount(withOwner('p-1'), 'noprobe-key-0001');
    await h.adapter.ensureSubAccount(withOwner('p-1'), 'noprobe-key-0002'); // a replay under a new key: nothing posted for it
    const before = posts(h.fake).length;
    const r = await attempt(h.adapter.ensureSubAccount(withOwner('p-2', { email: 'dana@example.test', mobile: '+14155550124' }), 'noprobe-key-0002'));
    expect(r).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(posts(h.fake)).toHaveLength(before);
    expect(h.fake.subAccountCount()).toBe(1);
  });

  it('an orphan from a lost response is adopted by a retry that has lost its ledger, with the vendor owner status, and nothing is posted', async () => {
    const h = harness({ wrap: losing('network') });
    const first = await h.adapter.ensureSubAccount(withOwner('p-1', { email: 'ownerfail@example.test' }), 'orphan-key-0001');
    expect(first.ownerStatus).toBe('failed');
    const fresh = new CrowdedMemberSubAccounts({ client: h.client, parentChapterId: h.parent, hmacKey: MAC_KEY });
    const before = posts(h.fake).length;
    // another purpose key and an empty ledger: the unclaimed named chapter is the member's orphan
    expect(await fresh.ensureSubAccount(withOwner('p-1', { email: 'ownerfail@example.test' }), 'orphan-key-0009')).toEqual(first);
    expect(posts(h.fake)).toHaveLength(before);
    expect(h.fake.subAccountCount()).toBe(1);
  });

  it('looks for an orphan by name BEFORE it creates: a chapter made earlier under the nonprofit is adopted with no POST', async () => {
    const h = harness();
    const made = await h.client.post(`/chapters/${h.parent}/subaccounts`, { name: 'Member p-1', email: 'invitee@example.test', idempotencyKey: '0190a0a0-0000-4000-8000-000000000001' });
    const orphan = (made.data as { id: string }).id;
    const r = await h.adapter.ensureSubAccount(invite('p-1'), 'orphan-key-0002');
    expect(r.subAccountRef).toBe(`s:${orphan}`);
    expect(posts(h.fake)).toHaveLength(1); // only the test's own
    expect(h.fake.subAccountCount()).toBe(1);
  });

  it('a same-named chapter under another parent is not reused', async () => {
    const h = harness();
    const elsewhere = h.fake.seedChapter('Another nonprofit');
    const made = await h.client.post(`/chapters/${elsewhere}/subaccounts`, { name: 'Member p-1', email: 'invitee@example.test', idempotencyKey: '0190a0a0-0000-4000-8000-000000000002' });
    const foreign = (made.data as { id: string }).id;
    const r = await h.adapter.ensureSubAccount(invite('p-1'), 'other-key-0001');
    expect(chapterOf(r.subAccountRef)).not.toBe(foreign);
    expect(posts(h.fake)).toHaveLength(2);
    expect(h.fake.subAccountCount()).toBe(2);
  });

  it('a name claimed for another party is VALIDATION_FAILED and nothing is posted; one claimed for another purpose of the same member is skipped', async () => {
    const ledger = new InMemoryKeyLedger();
    const h = harness({ ledger });
    const made = await h.client.post(`/chapters/${h.parent}/subaccounts`, { name: 'Member p-1', email: 'invitee@example.test', idempotencyKey: '0190a0a0-0000-4000-8000-000000000003' });
    const id = (made.data as { id: string }).id;
    await ledger.put(`msub:claim:${h.parent}:${id}`, { body: '', result: { party: 'someone-else', identity: 'x' } });
    const before = posts(h.fake).length;
    const r = await attempt(h.adapter.ensureSubAccount(invite('p-1'), 'claim-key-0001'));
    expect(r).toBeInstanceOf(MemberSubAccountError);
    expect(r).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(posts(h.fake)).toHaveLength(before);
    // the same member's other purpose: the claim names the member, so the chapter is skipped and a new one is made
    await ledger.put(`msub:claim:${h.parent}:${id}`, { body: '', result: { party: 'p-1', identity: 'another-purpose' } });
    const ok = await h.adapter.ensureSubAccount(invite('p-1'), 'claim-key-0002');
    expect(chapterOf(ok.subAccountRef)).not.toBe(id);
    expect(posts(h.fake)).toHaveLength(before + 1);
  });

  it('a 429 is QUOTA_EXCEEDED, is not retried, and makes no second lookup', async () => {
    const h = harness();
    h.fake.subAccountQuota = 0;
    const r = await attempt(h.adapter.ensureSubAccount(withOwner('p-1'), 'quota-key-0001'));
    expect(r).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(posts(h.fake)).toHaveLength(1);
    expect(searches(h.fake)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(0);
  });

  it('a 503 is PROVIDER_UNAVAILABLE and the create is not retried here', async () => {
    const h = harness();
    const r = await attempt(h.adapter.ensureSubAccount(withOwner('p-1', { email: 'outage@example.test' }), 'outage-key-0001'));
    expect(r).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(posts(h.fake)).toHaveLength(1);
    expect(h.fake.subAccountCount()).toBe(0);
    const h2 = harness();
    h2.fake.outageRequests = 1; // the lookup itself fails: nothing is posted
    expect(await attempt(h2.adapter.ensureSubAccount(withOwner('p-1'), 'outage-key-0002'))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(posts(h2.fake)).toHaveLength(0);
  });

  it('the owner object is sent only when given, otherwise the invitation email: never both', async () => {
    const h = harness();
    await h.adapter.ensureSubAccount(withOwner('p-1'), 'body-key-0001');
    await h.adapter.ensureSubAccount(invite('p-2'), 'body-key-0002');
    const [a, b] = posts(h.fake).map(sent) as [Record<string, unknown>, Record<string, unknown>];
    expect(a['owner']).toMatchObject({ firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', mobile: '+14155550123', dateOfBirth: '1991-04-17' });
    expect(a).not.toHaveProperty('email');
    expect(b['email']).toBe('invitee@example.test');
    expect(b).not.toHaveProperty('owner');
    expect(a['name']).toBe('Member p-1');
    expect(b['name']).toBe('Member p-2');
  });

  it('the wire key is a strict UUID v4, stable per idempotency key and different across keys', async () => {
    const h = harness();
    await h.adapter.ensureSubAccount(withOwner('p-1'), 'wire-key-0001');
    await h.adapter.ensureSubAccount(withOwner('p-2', { email: 'dana@example.test', mobile: '+14155550124' }), 'wire-key-0002');
    const keys = posts(h.fake).map((c) => sent(c)['idempotencyKey']);
    for (const k of keys) expect(String(k)).toMatch(V4);
    expect(new Set(keys).size).toBe(2);
    const again = harness();
    await again.adapter.ensureSubAccount(withOwner('p-1'), 'wire-key-0001');
    expect(sent(posts(again.fake)[0])['idempotencyKey']).toBe(keys[0]);
  });

  it('a reused key for a new member is IDEMPOTENCY_CONFLICT and creates nothing (the quota-first order is in the contract suite)', async () => {
    const h = harness();
    await h.adapter.ensureSubAccount(withOwner('p-1'), 'probe-key-0001');
    const r = await attempt(h.adapter.ensureSubAccount(withOwner('p-2', { email: 'dana@example.test', mobile: '+14155550124' }), 'probe-key-0001'));
    expect(r).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.fake.subAccountCount()).toBe(1);
  });

  it('reads the deposit account balance, hold and status, and never returns an account or routing number, even in an error', async () => {
    const h = harness();
    const a = await h.adapter.ensureSubAccount(withOwner('p-1'), 'read-key-0001');
    const ch = chapterOf(a.subAccountRef);
    h.fake.fund(ch, 12_345n);
    h.fake.holdSubAccount(ch, 345n);
    const v = await h.adapter.subAccount(a.subAccountRef);
    expect(v).toEqual({ status: 'open', balance: money(12_345n, 'USD'), hold: money(345n, 'USD'), available: money(12_000n, 'USD') });
    const errors: unknown[] = [];
    errors.push(await attempt(h.adapter.subAccount(a.accountRef)));
    errors.push(await attempt(h.adapter.subAccount(`s:${h.parent}`)));
    errors.push(await attempt(h.adapter.subAccount('s:ch999999')));
    h.fake.outageRequests = 1;
    errors.push(await attempt(h.adapter.subAccount(a.subAccountRef)));
    expect(errors.map((e) => (e as MemberSubAccountError).code)).toEqual(['UNKNOWN_ACCOUNT', 'UNKNOWN_ACCOUNT', 'UNKNOWN_ACCOUNT', 'PROVIDER_UNAVAILABLE']);
    const text = JSON.stringify([a, v, ...errors.map((e) => `${(e as Error).message} ${(e as Error).stack ?? ''} ${JSON.stringify(e)}`)], (_k, x) => (typeof x === 'bigint' ? String(x) : x));
    for (const secret of [h.fake.accountNumber(ch), ROUTING]) expect(text).not.toContain(secret);
  });

  it('a ref that is not s: is UNKNOWN_ACCOUNT with no request made', async () => {
    const h = harness();
    const before = h.fake.calls.length;
    for (const ref of ['c:1', 'a:1', 'ch000001', 's:ch1:acct1', 's:']) await expect(h.adapter.subAccount(ref)).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    expect(h.fake.calls.length).toBe(before);
  });

  it('keeps no personal data in the ledger: only keyed hashes, the party id and vendor ids', async () => {
    const entries: string[] = [];
    const inner = new InMemoryKeyLedger();
    const ledger: KeyLedger = {
      get: (k) => inner.get(k),
      put: async (k, e) => {
        entries.push(JSON.stringify([k, e]));
        await inner.put(k, e);
      },
    };
    const h = harness({ ledger });
    await h.adapter.ensureSubAccount(withOwner('p-1'), 'ledger-key-0001');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) for (const secret of ['Sarah', 'Cohen', OWNER.email, OWNER.mobile, '1991', '4155550123']) expect(e).not.toContain(secret);
  });

  it('refuses to build without the nonprofit chapter or a long enough secret', () => {
    const fake = new FakeCrowded({ token: TOKEN });
    const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: fake.fetch });
    const build = (o: { parentChapterId?: unknown; hmacKey?: unknown }) => () => new CrowdedMemberSubAccounts({ client, parentChapterId: 'ch1', hmacKey: MAC_KEY, ...o } as never);
    expect(build({})).not.toThrow();
    expect(build({ parentChapterId: undefined })).toThrow(/parentChapterId/);
    expect(build({ parentChapterId: '' })).toThrow(/parentChapterId/);
    expect(build({ parentChapterId: '../x' })).toThrow(/parentChapterId/);
    expect(build({ hmacKey: 'short' })).toThrow(/hmacKey/);
  });
});

// CrowdedMemberAccounts passes fundingAccountContract against FakeCrowded, and pins what Crowded adds (T-0699, TST-WAL-002,
// REQ-INS-022): one contact and one wallet account per member, a contact found by mobile before a create, the bulk answers'
// failure codes, self-describing refs (contact and account ids are numbers in separate id spaces), and no personal data
// persisted in clear or as an unsalted hash. All names, emails and mobiles are made up (example.test, 555 numbers).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { FundingAccountError, type EnsureAccountInput, type EnsuredAccount, type FundingTransaction } from '@kesher/ports';
import { fundingAccountContract } from '@kesher/ports/contracts';
import { CrowdedClient } from './client.ts';
import { FakeCrowded } from './fake-crowded.ts';
import { CrowdedMemberAccounts } from './member-accounts.ts';
import { InMemoryKeyLedger, type KeyLedger } from './institution-banking.ts';

const TOKEN = 'crowded_test_token_not_a_secret';
const BASE = 'https://sandbox.fake.invalid/api/v1';
const MAC_KEY = 'test-only-mac-key-not-a-secret-0123456789';

function harness(over: { ledger?: KeyLedger; pageSize?: number; fake?: FakeCrowded; chapterId?: string; clock?: { t: Date } } = {}) {
  const clock = over.clock ?? { t: new Date('2026-11-03T09:00:00Z') };
  const fake = over.fake ?? new FakeCrowded({ token: TOKEN, pageSize: over.pageSize ?? 2, now: () => clock.t });
  const chapterId = over.chapterId ?? fake.seedChapter();
  const ledger = over.ledger ?? new InMemoryKeyLedger();
  const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: fake.fetch });
  const adapter = new CrowdedMemberAccounts({ client, chapterId, hmacKey: MAC_KEY, ledger, now: () => clock.t });
  return { fake, adapter, chapterId, ledger, clock, client };
}

const world = new WeakMap<object, ReturnType<typeof harness>>();
const make = () => {
  const h = harness();
  world.set(h.adapter, h);
  return h.adapter;
};
const w = (p: object) => world.get(p)!;
const walletOf = (ref: string): number => Number(ref.replace(/^a:/, ''));

fundingAccountContract('crowded member accounts (fake)', make, {
  rejectedEmail: 'rejected@example.test',
  frozenEmail: 'frozen@example.test',
  outageEmail: 'outage@example.test',
  controls: {
    credit: (p, ref, amount) => w(p).fake.creditWallet(walletOf(ref), amount.minor),
    debit: (p, ref, amount) => w(p).fake.debitWallet(walletOf(ref), amount.minor),
    hold: (p, ref, amount) => w(p).fake.holdWallet(walletOf(ref), amount.minor),
    setStatus: (p, ref, status) => w(p).fake.setAccountStatus(walletOf(ref), status === 'open' ? 'Open' : status === 'frozen' ? 'Frozen' : 'Closed'),
    setChecking: (p, amount) => w(p).fake.setChecking(w(p).chapterId, amount.minor),
    advance: (p, ms) => void (w(p).clock.t = new Date(w(p).clock.t.getTime() + ms)),
    now: (p) => w(p).clock.t,
  },
});

const SARAH: EnsureAccountInput = { partyId: 'p-1', firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', mobile: '+14155550123', dateOfBirth: '1991-04-17' };
const DANA: EnsureAccountInput = { partyId: 'p-2', firstName: 'Dana', lastName: 'Levi', email: 'dana.levi@example.test', mobile: '+14155550124' };
const refs = (r: EnsuredAccount) => {
  if (!('accountRef' in r)) throw new Error('no account');
  return r;
};
const collect = async (it: AsyncIterable<FundingTransaction>) => {
  const out: FundingTransaction[] = [];
  for await (const t of it) out.push(t);
  return out;
};
const posts = (fake: FakeCrowded, suffix: string) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));

describe('CrowdedMemberAccounts over the fake (T-0699)', () => {
  it('two calls with one party make one contact and one wallet account at the vendor', async () => {
    const h = harness();
    const a = await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    const b = await h.adapter.ensureAccount(SARAH, 'ensure-key-0002');
    expect(b).toEqual(a);
    expect(h.fake.count('contacts')).toBe(1);
    expect(h.fake.count('accounts')).toBe(1);
    expect(posts(h.fake, '/contacts')).toHaveLength(1);
    expect(posts(h.fake, '/accounts')).toHaveLength(1);
  });

  it('refs are self-describing: c: and a: prefixes, and a contact id is never read as an account id even when the numbers are equal', async () => {
    const h = harness();
    const r = refs(await h.adapter.ensureAccount(SARAH, 'ensure-key-0001'));
    expect(r.contactRef).toMatch(/^c:\d+$/);
    expect(r.accountRef).toMatch(/^a:\d+$/);
    // the fake numbers contacts and wallets separately, so contact 1 and account 1 both exist
    expect(r.contactRef.slice(2)).toBe(r.accountRef.slice(2));
    const before = h.fake.calls.length;
    await expect(h.adapter.account(r.contactRef)).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    await expect(h.adapter.account(r.contactRef.slice(2))).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    await expect(h.adapter.account('a:../../x')).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    await expect(collect(h.adapter.transactions({ accountRef: r.contactRef, from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }))).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    expect(h.fake.calls.length).toBe(before); // refused before any request
    expect((await h.adapter.account(r.accountRef)).status).toBe('open');
  });

  it('finds a contact the vendor already holds under the mobile (a lost response) and does not create it again', async () => {
    const h = harness();
    await h.client.post(`/chapters/${h.chapterId}/contacts`, [{ firstName: 'Sarah', lastName: 'Cohen', mobile: SARAH.mobile, email: SARAH.email }]);
    expect(h.fake.count('contacts')).toBe(1);
    const r = refs(await h.adapter.ensureAccount(SARAH, 'ensure-key-0001'));
    expect(h.fake.count('contacts')).toBe(1);
    expect(posts(h.fake, '/contacts')).toHaveLength(1); // only the test's own create
    expect(h.fake.count('accounts')).toBe(1);
    expect(r.contactRef).toBe(`c:${h.fake.contactId(SARAH.mobile)}`);
  });

  it('with the ledger lost, the same member is found by mobile and the account create answers accountCreated false', async () => {
    const h = harness();
    const a = await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    const fresh = harness({ fake: h.fake, chapterId: h.chapterId, clock: h.clock }).adapter;
    expect(await fresh.ensureAccount(SARAH, 'ensure-key-0001')).toEqual(a);
    expect(h.fake.count('contacts')).toBe(1);
    expect(h.fake.count('accounts')).toBe(1);
  });

  it('a second adapter on the same ledger replays without any create', async () => {
    const h = harness();
    const a = await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    const again = harness({ fake: h.fake, chapterId: h.chapterId, ledger: h.ledger, clock: h.clock }).adapter;
    const creates = posts(h.fake, '/contacts').length + posts(h.fake, '/accounts').length;
    expect(await again.ensureAccount(SARAH, 'ensure-key-0009')).toEqual(a);
    expect(posts(h.fake, '/contacts').length + posts(h.fake, '/accounts').length).toBe(creates);
  });

  it('a duplicate mobile that belongs to another party in our records is DUPLICATE_MOBILE with no request to the vendor', async () => {
    const h = harness();
    await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    const before = h.fake.calls.length;
    await expect(h.adapter.ensureAccount({ ...DANA, mobile: SARAH.mobile }, 'ensure-key-0002')).rejects.toMatchObject({ code: 'DUPLICATE_MOBILE' });
    expect(h.fake.calls.length).toBe(before);
  });

  it('a bulk account answer with error true and PROVISION_FAILED is PROVIDER_UNAVAILABLE, and a retry then succeeds on the same contact', async () => {
    const h = harness();
    h.fake.accountProvisionError = 'PROVISION_FAILED';
    await expect(h.adapter.ensureAccount(SARAH, 'ensure-key-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.count('accounts')).toBe(0);
    h.fake.accountProvisionError = undefined;
    const r = await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    expect(r.status).toBe('open');
    expect(h.fake.count('contacts')).toBe(1);
    expect(h.fake.count('accounts')).toBe(1);
  });

  it('CONTACT_NOT_FOUND after a create is PROVIDER_UNAVAILABLE', async () => {
    const h = harness();
    h.fake.accountProvisionError = 'CONTACT_NOT_FOUND';
    await expect(h.adapter.ensureAccount(SARAH, 'ensure-key-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a contact the vendor marks Failed later is rejected on the next call, and a Frozen account is frozen', async () => {
    const h = harness();
    const a = refs(await h.adapter.ensureAccount(SARAH, 'ensure-key-0001'));
    h.fake.freezeAccount(walletOf(a.accountRef));
    expect((await h.adapter.ensureAccount(SARAH, 'ensure-key-0002')).status).toBe('frozen');
    const d = await h.adapter.ensureAccount(DANA, 'ensure-key-0003');
    expect(d.status).toBe('open');
    h.fake.failContact(DANA.mobile);
    expect(await h.adapter.ensureAccount(DANA, 'ensure-key-0003')).toEqual({ contactRef: d.contactRef, status: 'rejected' });
  });

  it('a rejected member re-applying with corrected data is PARTY_CONFLICT (an open question, not a policy here)', async () => {
    const h = harness();
    const bad = { ...SARAH, email: 'rejected@example.test' };
    expect((await h.adapter.ensureAccount(bad, 'ensure-key-0001')).status).toBe('rejected');
    await expect(h.adapter.ensureAccount({ ...SARAH, email: 'sarah.fixed@example.test' }, 'ensure-key-0002')).rejects.toMatchObject({ code: 'PARTY_CONFLICT' });
    expect(h.fake.count('contacts')).toBe(1);
  });

  it('account() returns balance, hold and available as bigint cents and never the account or routing number, in a result or an error', async () => {
    const h = harness();
    const r = refs(await h.adapter.ensureAccount(SARAH, 'ensure-key-0001'));
    const id = walletOf(r.accountRef);
    h.fake.setBalance(id, 12_345n);
    h.fake.holdWallet(id, 345n);
    const v = await h.adapter.account(r.accountRef);
    expect(v).toMatchObject({ status: 'open', balance: money(12_345n, 'USD'), hold: money(345n, 'USD'), available: money(12_000n, 'USD') });
    expect(typeof v.available.minor).toBe('bigint');
    const number = h.fake.walletNumber(id);
    const text = JSON.stringify([r, v], (_k, x) => (typeof x === 'bigint' ? String(x) : x));
    expect(text).not.toContain(number);
    expect(text).not.toContain('084106768');
    h.fake.outageRequests = 1;
    const e = await h.adapter.account(r.accountRef).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(FundingAccountError);
    expect(`${(e as Error).message} ${(e as Error).stack} ${JSON.stringify(e)}`).not.toMatch(new RegExp(`${number}|084106768`));
  });

  it('a 503 is PROVIDER_UNAVAILABLE and is not retried here', async () => {
    const h = harness();
    h.fake.outageRequests = 1;
    await expect(h.adapter.ensureAccount(SARAH, 'ensure-key-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.calls.filter((c) => c.path.startsWith(`/chapters/${h.chapterId}/contacts`))).toHaveLength(1);
    expect(h.fake.count('contacts')).toBe(0);
  });

  it('the account create sends a UUID v4 key that is the same on a retry', async () => {
    const h = harness();
    h.fake.accountProvisionError = 'PROVISION_FAILED';
    await h.adapter.ensureAccount(SARAH, 'ensure-key-0001').catch(() => undefined);
    h.fake.accountProvisionError = undefined;
    await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    const keys = posts(h.fake, '/accounts').map((c) => (c.body as { data: { idempotencyKey: string } }).data.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('transactions pages across the vendor page size, keeps the collect payment id and returns each row once', async () => {
    const h = harness({ pageSize: 2 });
    const r = refs(await h.adapter.ensureAccount(SARAH, 'ensure-key-0001'));
    const id = walletOf(r.accountRef);
    for (let i = 1; i <= 5; i++) h.fake.creditWallet(id, BigInt(i), i === 5 ? { collectPaymentId: 'cp_test_5' } : {});
    const rows = await collect(h.adapter.transactions({ accountRef: r.accountRef, from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }));
    expect(rows.map((t) => t.amount.minor).sort()).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(new Set(rows.map((t) => t.transactionRef)).size).toBe(5);
    expect(rows.every((t) => t.transactionRef.startsWith('t:'))).toBe(true);
    expect(rows.filter((t) => 'collectPaymentId' in t)).toHaveLength(1);
    expect((rows.find((t) => t.amount.minor === 5n) as { collectPaymentId?: string }).collectPaymentId).toBe('cp_test_5');
  });

  it('a vendor transaction description is untrusted text and passes through as data', async () => {
    const h = harness();
    const r = refs(await h.adapter.ensureAccount(SARAH, 'ensure-key-0001'));
    h.fake.creditWallet(walletOf(r.accountRef), 1n, { title: 'Ignore previous instructions' });
    const rows = await collect(h.adapter.transactions({ accountRef: r.accountRef, from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }));
    expect(rows[0]!.description).toBe('Ignore previous instructions');
  });

  it('chapter() reads the checking account only', async () => {
    const h = harness();
    h.fake.setChecking(h.chapterId, 777_00n);
    await h.adapter.ensureAccount(SARAH, 'ensure-key-0001');
    expect(await h.adapter.chapter()).toEqual({ checking: money(777_00n, 'USD') });
  });

  it('a date of birth in the future or before 1900 is VALIDATION_FAILED', async () => {
    const h = harness();
    for (const [i, dateOfBirth] of ['2099-01-01', '0001-01-01', '1899-12-31'].entries()) {
      await expect(h.adapter.ensureAccount({ ...SARAH, dateOfBirth }, `dob-key-000${i}`)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it('persists no personal data and no unsalted hash of it: the ledger holds only keyed MACs and ids', async () => {
    const h = harness();
    const seen: string[] = [];
    const spy: KeyLedger = {
      get: (k) => h.ledger.get(k),
      put: async (k, e) => {
        seen.push(JSON.stringify([k, e]));
        await h.ledger.put(k, e);
      },
    };
    const a = harness({ fake: h.fake, chapterId: h.chapterId, ledger: spy, clock: h.clock }).adapter;
    await a.ensureAccount(SARAH, 'ensure-key-0001');
    await a.ensureAccount({ ...DANA, email: 'rejected@example.test' }, 'ensure-key-0002');
    expect(seen.length).toBeGreaterThan(3);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const fields = [SARAH.mobile, SARAH.email, 'Sarah', 'Cohen', '1991-04-17', DANA.mobile, 'Dana', 'Levi', 'rejected@example.test'];
    const unsalted = new Set<string>();
    for (const f of fields) {
      for (const v of [f, f.toLowerCase()]) {
        unsalted.add(sha(v));
        unsalted.add(sha(JSON.stringify([v])));
        unsalted.add(createHash('sha256').update(v).digest('base64'));
      }
    }
    unsalted.add(sha(JSON.stringify(['Sarah', 'Cohen', SARAH.email, SARAH.mobile, '1991-04-17'])));
    unsalted.add(sha(JSON.stringify(['Sarah', 'Cohen', SARAH.email.toLowerCase(), SARAH.mobile, '1991-04-17'])));
    unsalted.add(sha(JSON.stringify(['p-1', sha(JSON.stringify(['Sarah', 'Cohen', SARAH.email.toLowerCase(), SARAH.mobile, '1991-04-17']))])));
    const blob = seen.join('\n');
    for (const f of fields) expect(blob).not.toContain(f);
    for (const hash of unsalted) expect(blob).not.toContain(hash);
  });

  it('refuses to be built without a MAC key of enough length, and a different key gives different stored values', async () => {
    const fake = new FakeCrowded({ token: TOKEN });
    const client = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: fake.fetch });
    const chapterId = fake.seedChapter();
    expect(() => new CrowdedMemberAccounts({ client, chapterId, hmacKey: '' })).toThrow();
    expect(() => new CrowdedMemberAccounts({ client, chapterId, hmacKey: 'short' })).toThrow();
    expect(() => new CrowdedMemberAccounts({ client, chapterId: '', hmacKey: MAC_KEY })).toThrow();
    const stored = async (key: string) => {
      const entries: string[] = [];
      const ledger: KeyLedger = { get: async () => undefined, put: async (k, e) => void entries.push(JSON.stringify([k, e])) };
      const f = new FakeCrowded({ token: TOKEN });
      const c = new CrowdedClient({ baseUrl: BASE, token: TOKEN, fetch: f.fetch });
      await new CrowdedMemberAccounts({ client: c, chapterId: f.seedChapter(), hmacKey: key, ledger }).ensureAccount(SARAH, 'ensure-key-0001');
      return entries.filter((e) => e.includes('mobile') || e.includes('party')).join('|');
    };
    expect(await stored(MAC_KEY)).not.toBe(await stored(`${MAC_KEY}-other`));
  });
});

describe('ledger failures (T-0735, TST-INS-006)', () => {
  const boom = () => new Error('db down postgres://secret@host/x');
  /** A ledger that fails the chosen call (`get` or `put`) from the `after`th call of it on, while `armed`. */
  const flaky = (broken: 'get' | 'put', after = 0) => {
    const inner = new InMemoryKeyLedger();
    const state = { armed: false, seen: 0 };
    const trip = (op: 'get' | 'put'): boolean => op === broken && state.armed && state.seen++ >= after;
    const ledger: KeyLedger = {
      get: async (k) => (trip('get') ? Promise.reject(boom()) : inner.get(k)),
      put: async (k, v) => (trip('put') ? Promise.reject(boom()) : inner.put(k, v)),
    };
    return { ledger, state };
  };

  it('a ledger that cannot be read or written is PROVIDER_UNAVAILABLE with fixed text, never a bare Error', async () => {
    for (const broken of ['get', 'put'] as const) {
      const { ledger, state } = flaky(broken);
      const h = harness({ ledger });
      state.armed = true;
      const e = await h.adapter.ensureAccount(SARAH, 'key-ledger-0001').then(() => undefined, (x: unknown) => x);
      expect(e, broken).toBeInstanceOf(FundingAccountError);
      expect(e, broken).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect((e as Error).message, broken).not.toMatch(/postgres|key-ledger-0001/);
    }
  });

  it('a contact made before the ledger write failed is not made again on the replay', async () => {
    const { ledger, state } = flaky('put');
    const h = harness({ ledger });
    state.armed = true;
    await expect(h.adapter.ensureAccount(SARAH, 'key-ledger-0002')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(h.fake.count('contacts')).toBe(1);
    state.armed = false;
    const r = await h.adapter.ensureAccount(SARAH, 'key-ledger-0002');
    expect(r).toMatchObject({ status: 'open' });
    expect([h.fake.count('contacts'), h.fake.count('accounts')]).toEqual([1, 1]);
  });
});

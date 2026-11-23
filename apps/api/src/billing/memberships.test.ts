// T-0312 (REQ-BIL-002, REQ-BIL-003, review F40): starting a membership by hand starts a recurring charge, so POST /memberships
// needs a fresh step-up and the flag; the member is the caller or someone who accepted the caller's invite; a key is its caller's;
// the plan and term are checked before the billing vendor hears of it; and a member's existing membership is not displaced.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice, type BillingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { StaticFlags } from './capabilities.ts';

let db: TestDatabase;
let app: App;
let off: App;
let host: SimulatorHost;
let billing: BillingPort;
const NOW = new Date('2026-11-10T09:00:00Z');
type Who = { partyId: string; access: string; stepUp: string };
const people: Record<string, Who> = {};

async function person(a: App, phone: string): Promise<Who> {
  const s = a.services;
  const started = await s.otp.start({ phone, locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `d-${phone}`, deviceName: 'Phone' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `d-${phone}`, deviceName: 'Phone', response: await device.register(r1.options!) });
  const access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  return { partyId: principal.partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

const post = (a: App, who: string, body: unknown, opts: { key?: string; stepUp?: boolean } = {}) =>
  dispatch(a, {
    method: 'POST',
    url: '/v1/memberships',
    headers: { authorization: `Bearer ${people[who]!.access}`, ...(opts.stepUp === false ? {} : { 'x-step-up': people[who]!.stepUp }), ...(opts.key === undefined ? {} : { 'idempotency-key': opts.key }) },
    rawBody: JSON.stringify(body),
    now: NOW,
  });
const ask = (member: string, extra: Record<string, unknown> = {}) => ({ memberPartyId: people[member]!.partyId, planCode: 'demo-club-us', ...extra });
const memberships = async (memberParty: string) => (await db.query(`select 1 from billing.membership where member_party_id = $1`, [memberParty])).rows.length;

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  const base = { db, market: 'US' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...base, registry: host.registry, flags: new StaticFlags(undefined, { 'billing.stripe': true }) });
  billing = host.registry.resolve<BillingPort>('billing', 'US');
  const offHost = new SimulatorHost();
  off = createApp({ ...base, registry: offHost.registry, flags: new StaticFlags(undefined, { 'billing.stripe': false }) });
  let n = 0;
  for (const who of ['ben', 'dana', 'tal', 'eli', 'self', 'gil', 'zed']) people[who] = await person(app, `+14155550${100 + n++}`);
  people['offBen'] = await person(off, '+14155550199');
  await app.services.plans.ensurePlan('demo-club-us', 'Demo Club US');
  await app.services.plans.createVersion({ planCode: 'demo-club-us', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  // Dana accepted Ben's invite (T-0307): the one stranger Ben may start a membership for.
  await db.query(
    `insert into billing.funder_invite (id, idempotency_key, funder_party_id, member_name, contact_kind, contact, plan_code, plan_version, token_hash, status, expires_at, last_sent_at, member_party_id, created_at)
     values ($1, 'invite-dana-0001', $2, 'Dana', 'phone', '+14155550101', 'demo-club-us', 1, 'hash-dana', 'accepted', $3, $4, $5, $4)`,
    [uuidv7(NOW), people['ben']!.partyId, new Date(NOW.getTime() + 86_400_000), NOW, people['dana']!.partyId],
  );
}, 120_000);
afterAll(async () => db.close());

describe('POST /memberships (T-0312)', () => {
  it('without a fresh step-up it is refused 401 and no membership or charge is created', async () => {
    const create = vi.spyOn(billing, 'createSubscription');
    const r = await post(app, 'ben', ask('dana'), { key: 'ben-dana-nostepup', stepUp: false });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(create).not.toHaveBeenCalled();
    expect(await memberships(people['dana']!.partyId)).toBe(0);
    create.mockRestore();
  });

  it('with billing.stripe off it answers 404 FEATURE_OFF', async () => {
    const r = await post(off, 'offBen', { memberPartyId: people['offBen']!.partyId, planCode: 'demo-club-us' }, { key: 'off-ben-0001' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'FEATURE_OFF' });
  });

  it('a stranger as the member is refused 403; the caller and a member who accepted the caller\'s invite are allowed', async () => {
    const create = vi.spyOn(billing, 'createSubscription');
    const stranger = await post(app, 'ben', ask('tal'), { key: 'ben-tal-0001' });
    expect(stranger.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(await memberships(people['tal']!.partyId)).toBe(0);
    expect((await post(app, 'self', ask('self'), { key: 'self-self-0001' })).status).toBe(201);
    expect((await post(app, 'ben', ask('dana'), { key: 'ben-dana-0001' })).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
    create.mockRestore();
  });

  it('a key another caller used answers 409 and hands back nothing; the owner repeating it gets the same membership', async () => {
    const first = await post(app, 'gil', ask('gil'), { key: 'gil-shared-key-1' });
    expect(first.status).toBe(201);
    const other = await post(app, 'eli', ask('eli'), { key: 'gil-shared-key-1' });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await memberships(people['eli']!.partyId)).toBe(0);
    const again = await post(app, 'gil', ask('gil'), { key: 'gil-shared-key-1' });
    expect(again.body).toMatchObject({ id: (first.body as { id: string }).id });
  });

  it('an unknown plan or a term outside 1 to 12 answers 422 and the billing vendor is never called', async () => {
    const create = vi.spyOn(billing, 'createSubscription');
    for (const [key, extra] of [['eli-bad-plan-01', { planCode: 'no-such-plan' }], ['eli-term-zero-1', { termMonths: 0 }], ['eli-term-big-01', { termMonths: 13 }], ['eli-term-frac-1', { termMonths: 2.5 }]] as const) {
      expect((await post(app, 'eli', ask('eli', extra), { key })).status).toBe(422);
    }
    expect(create).not.toHaveBeenCalled();
    expect(await memberships(people['eli']!.partyId)).toBe(0);
    create.mockRestore();
  });

  it('a member who already holds a membership is not displaced by another', async () => {
    const create = vi.spyOn(billing, 'createSubscription');
    const r = await post(app, 'ben', ask('dana'), { key: 'ben-dana-0002' });
    expect(r.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
    expect(await memberships(people['dana']!.partyId)).toBe(1);
    create.mockRestore();
  });
});
describe('the database refuses a second open membership for a member (T-0313)', () => {
  it('a second create for a member who holds one is refused before the vendor is called; a cancelled one does not block a new start', async () => {
    const member = people['tal']!.partyId;
    const funder = people['ben']!.partyId;
    const make = (key: string) => app.services.memberships.create({ idempotencyKey: key, memberPartyId: member, funderPartyId: funder, funderEmail: 'ben@example.com', planCode: 'demo-club-us' }, NOW);
    const create = vi.spyOn(billing, 'createSubscription');
    const first = await make('race-key-0001');
    await expect(make('race-key-0002')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await memberships(member)).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    // The same key repeated is the same membership, not a conflict.
    expect((await make('race-key-0001')).id).toBe(first.id);
    create.mockRestore();
    await app.services.memberships.setStatus(first.id, 'cancelled', NOW);
    expect((await make('race-key-0003')).id).not.toBe(first.id);
    expect(await memberships(member)).toBe(2);
  });
  it('a lost race: the subscription it made is ended, its key is refused afterwards (no replay of the ended one), and a cancel that fails opens a case', async () => {
    const member = people['zed']!.partyId;
    const funder = people['ben']!.partyId;
    const make = (key: string) => app.services.memberships.create({ idempotencyKey: key, memberPartyId: member, funderPartyId: funder, funderEmail: 'ben@example.com', planCode: 'demo-club-us' }, NOW);
    // The pre-check passed; another request then wins the member while this one is at the vendor: the index settles it.
    const real = billing.createSubscription.bind(billing);
    const create = vi.spyOn(billing, 'createSubscription').mockImplementationOnce(async (...args) => {
      await make('winner-key-0001');
      return real(...args);
    });
    const cancel = vi.spyOn(billing, 'cancel').mockRejectedValueOnce(new Error('vendor down'));
    await expect(make('lost-key-0001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]![2].length).toBeLessThanOrEqual(128);
    expect(await memberships(member)).toBe(1);
    expect((await db.query(`select 1 from ops.case where kind = 'membership_orphan_subscription'`)).rows).toHaveLength(1);
    // The winner ends; the lost key is still refused, and the vendor is not asked (it would replay the ended subscription).
    const winner = (await app.services.memberships.byKey('winner-key-0001'))!;
    await app.services.memberships.setStatus(winner.id, 'cancelled', NOW);
    create.mockClear();
    await expect(make('lost-key-0001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
    cancel.mockRestore();
  });
});


// T-0770: the lost-race key. `lostKeys` is the one place that names where it is stored: ops.workflow_marker (claim = the key) since
// T-0770, with rows written before it in ops.external_ref still honoured.
const lostKeys = {
  async count(key: string): Promise<number> {
    return (await db.query<{ n: number }>(`select count(*)::int as n from ops.workflow_marker where kind = 'membership_lost_key' and claim = $1`, [key])).rows[0]!.n;
  },
  async countOld(key: string): Promise<number> {
    return (await db.query<{ n: number }>(`select count(*)::int as n from ops.external_ref where entity_type = 'membership_lost_key' and external_id = $1`, [key])).rows[0]!.n;
  },
  async plant(key: string): Promise<void> {
    await db.query(`insert into ops.workflow_marker (kind, subject_id, seq, value, claim) values ('membership_lost_key', $1, 0, 'lost', $2)`, [uuidv7(NOW), key]);
  },
  async plantOld(key: string): Promise<void> {
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('membership_lost_key', $1, 'stripe', $2)`, [uuidv7(NOW), key]);
  },
};
const endLost = (key: string, memberParty: string) => (app.services.memberships as unknown as { endLostSubscription(k: string, m: string, s: string, n: Date): Promise<void> }).endLostSubscription(key, memberParty, `sub_${uuidv7(NOW)}`, NOW);

describe('the lost-race key (T-0770)', () => {
  it('a key is remembered once however many lost races name it: the first writer wins and the second is quiet', async () => {
    const cancel = vi.spyOn(billing, 'cancel').mockResolvedValue(undefined as never);
    const key = `lost-twice-${uuidv7(NOW)}`;
    await endLost(key, people['gil']!.partyId);
    await endLost(key, people['eli']!.partyId);
    expect(await lostKeys.count(key)).toBe(1);
    expect(await lostKeys.countOld(key)).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
    cancel.mockRestore();
  });

  it('a remembered key is refused before any vendor call, and a key nobody lost is not refused for that reason', async () => {
    const create = vi.spyOn(billing, 'createSubscription');
    const key = `lost-planted-${uuidv7(NOW)}`;
    await lostKeys.plant(key);
    const make = (k: string, member: string) => app.services.memberships.create({ idempotencyKey: k, memberPartyId: people[member]!.partyId, funderPartyId: people['ben']!.partyId, funderEmail: 'ben@example.com', planCode: 'demo-club-us' }, NOW);
    await expect(make(key, 'tal')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', message: expect.stringContaining('That request was refused because the member already had a membership') });
    expect(create).not.toHaveBeenCalled();
    const other = await make(`lost-not-planted-${uuidv7(NOW)}`, 'tal').then(() => 'made', (e: unknown) => (e as Error).message);
    expect(other).not.toContain('That request was refused because');
    create.mockRestore();
  });

  const REFUSED = 'That request was refused because the member already had a membership';
  const attempt = async (key: string) => {
    const create = vi.spyOn(billing, 'createSubscription');
    const r = await app.services.memberships.create({ idempotencyKey: key, memberPartyId: people['tal']!.partyId, funderPartyId: people['ben']!.partyId, funderEmail: 'ben@example.com', planCode: 'demo-club-us' }, NOW).then(() => 'made', (e: unknown) => (e as Error).message);
    const calls = create.mock.calls.length;
    create.mockRestore();
    return { refusedAsLost: r.startsWith(REFUSED), vendorCalls: calls };
  };
  it.each([
    ['neither', false, false, false],
    ['the old row only (written before T-0770)', false, true, true],
    ['the new marker only', true, false, true],
    ['both present', true, true, true],
  ])('a retry of a key with %s is refused as lost: %s', async (_name, fresh, old, refusedAsLost) => {
    const key = `lost-combo-${uuidv7(NOW)}`;
    if (fresh) await lostKeys.plant(key);
    if (old) await lostKeys.plantOld(key);
    const r = await attempt(key);
    expect(r.refusedAsLost).toBe(refusedAsLost);
    if (refusedAsLost) expect(r.vendorCalls).toBe(0);
  });

  it('a key already remembered in the old table stays quiet when a lost race names it again: the new marker is written once, never twice', async () => {
    const cancel = vi.spyOn(billing, 'cancel').mockResolvedValue(undefined as never);
    const key = `lost-old-then-new-${uuidv7(NOW)}`;
    await lostKeys.plantOld(key);
    await endLost(key, people['gil']!.partyId);
    await endLost(key, people['eli']!.partyId);
    expect(await lostKeys.count(key)).toBe(1);
    expect(await lostKeys.countOld(key)).toBe(1);
    cancel.mockRestore();
  });
});

describe('the lost-race key against a reference model (T-0770 differential)', () => {
  const isLost = (key: string) => (app.services.memberships as unknown as { isLostKey(k: string): Promise<boolean> }).isLostKey(key);
  it('300 random histories: a key reads as lost iff an old row or a lost race named it, and each lost race writes the new marker at most once', async () => {
    const cancel = vi.spyOn(billing, 'cancel').mockResolvedValue(undefined as never);
    let seed = 0x770;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
    const members = [people['gil']!.partyId, people['eli']!.partyId];
    for (let i = 0; i < 300; i++) {
      const keys = Array.from({ length: 4 }, (_, k) => `diff-lost-${i}-${k}-${uuidv7(NOW)}`);
      const old = new Set<string>();
      for (const k of keys) if (rnd(3) === 0) { old.add(k); await lostKeys.plantOld(k); }
      const lost = new Set<string>();
      for (let o = 0, n = rnd(6); o < n; o++) {
        const k = keys[rnd(4)]!;
        await endLost(k, members[rnd(2)]!);
        lost.add(k);
        for (const q of keys) {
          expect(await isLost(q)).toBe(old.has(q) || lost.has(q));
          expect(await lostKeys.count(q)).toBe(lost.has(q) ? 1 : 0);
          expect(await lostKeys.countOld(q)).toBe(old.has(q) ? 1 : 0);
        }
      }
      for (const q of keys) expect(await isLost(q)).toBe(old.has(q) || lost.has(q));
    }
    cancel.mockRestore();
  }, 120_000);
});

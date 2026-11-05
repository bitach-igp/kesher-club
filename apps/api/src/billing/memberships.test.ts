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
  for (const who of ['ben', 'dana', 'tal', 'eli', 'self', 'gil']) people[who] = await person(app, `+14155550${100 + n++}`);
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

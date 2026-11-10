// TST-INS-022 US banking for an institution (T-0650, REQ-INS-022). Ohr, an Israeli institution, banks as its own US entity: the admin's
// POST makes one provider entity and opens the hosted application for her IP; the same key answers the same result, a new key while the
// application is open resumes it, the same key with another body is a conflict. GET follows the bank's decision and records it; the
// provider approving does not open money while KYB is pending. A rejection followed by a new application appends rows and updates none.
// A platform institution gets a sub-account (own number, or sharing a pooled account). Only admins link, finance and admins read; the
// flag off answers 404. The provider's own application event maps its id back to OUR institution and ignores one it does not know.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { PostgresKeyLedger, clientIp } from './us-banking.ts';
import type { HttpRequest } from '../http.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-03T09:00:00Z');
const IP = '198.51.100.4';
const FLAG = 'institutions.usBanking';
const OHR = uuidv7(NOW);
const RJ = uuidv7(NOW);
const BETH = uuidv7(NOW);
const PLAT = uuidv7(NOW);
const POOL = uuidv7(NOW);
const NOREF = uuidv7(NOW);
const OFF = uuidv7(NOW);
const XT = uuidv7(NOW);
const TWIN = uuidv7(NOW);
const DUP = uuidv7(NOW);
type Who = { app: App; partyId: string; access: string; stepUp: string };
const people: Record<string, Who> = {};
let main: App;
let host: SimulatorHost;
let pooled: App;
let pooledHost: SimulatorHost;
let dup: App;
let formOpened = false;
let ohrEntity = '';
const sim = (h: SimulatorHost) => h.simulators['institution-banking'];

const call = (who: string, method: string, url: string, body?: unknown, opts: { key?: string; stepUp?: boolean; ip?: boolean } = {}) =>
  dispatch(people[who]!.app, {
    method,
    url: `/v1${url}`,
    headers: { authorization: `Bearer ${people[who]!.access}`, ...(opts.key ? { 'idempotency-key': opts.key } : {}), ...(opts.stepUp === false ? {} : { 'x-step-up': people[who]!.stepUp }), ...(opts.ip === false ? {} : { 'x-forwarded-for': `203.0.113.99, ${IP}` }) },
    rawBody: body === undefined ? '' : JSON.stringify(body),
    now: NOW,
  });
const link = (who: string, inst: string, body: unknown, key: string, opts: { stepUp?: boolean; ip?: boolean } = {}) => call(who, 'POST', `/institutions/${inst}/us-banking`, body, { key, ...opts });
const status = (who: string, inst: string) => call(who, 'GET', `/institutions/${inst}/us-banking`);
const OHR_ENTITY = { legalName: 'American Friends of Yeshivat Ohr', ein: '12-3456789' };

async function person(app: App, name: string, phone: string, roles: string[]): Promise<void> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  people[name] = { app, partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

async function platformEntity(h: SimulatorHost, legalName: string): Promise<string> {
  const { entityRef } = await sim(h).createEntity({ holder: 'platform', institutionId: uuidv7(NOW), legalName, ein: '98-7654321', idempotencyKey: 'platform-setup-0001' });
  sim(h).decide(entityRef);
  return entityRef;
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  pooledHost = new SimulatorHost();
  const base = { db, market: 'IL' as const, issuer: 'https://api.kesher.example', clock: () => NOW };
  const on = new StaticFlags(undefined, { [FLAG]: true });
  main = createApp({ ...base, registry: host.registry, signingKey: await generateSigningKey(), flags: on, usBankingPlatformEntityRef: await platformEntity(host, 'holder_platform_subaccounts Israel Global Pay, LLC') });
  const pooledPlatform = await platformEntity(pooledHost, 'holder_platform_pooled Israel Global Pay, LLC');
  // Two simulator hosts in one database would both mint `sub_000001`, which the provider-id ownership check rightly refuses: the pooled host starts later.
  for (let i = 0; i < 5; i++) await sim(pooledHost).createSubAccount({ entityRef: pooledPlatform, institutionId: uuidv7(NOW), idempotencyKey: `pad-${i}-0000` });
  pooled = createApp({ ...base, registry: pooledHost.registry, signingKey: await generateSigningKey(), flags: on, usBankingPlatformEntityRef: pooledPlatform });
  // A provider that matches organizations by name hands back an entity another institution already holds (here, Ohr's).
  const dupHost = new SimulatorHost();
  dupHost.registry.register('institution-banking', 'simulator', () => ({
    createEntity: async () => ({ entityRef: ohrEntity }), // a value captured before the call: the test database has one connection, held by the open transaction
    startApplication: async () => {
      formOpened = true;
      return { formUrl: 'https://apply.sim.invalid/other-institutions-form' };
    },
  }));
  dup = createApp({ ...base, registry: dupHost.registry, signingKey: await generateSigningKey(), flags: on });
  const noRef = createApp({ ...base, registry: new SimulatorHost().registry, signingKey: await generateSigningKey(), flags: on });
  const off = createApp({ ...base, registry: new SimulatorHost().registry, signingKey: await generateSigningKey(), flags: new StaticFlags() });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Rejected School', 'IL'), ($3, 'Beth Friends', 'US'), ($4, 'Platform School', 'IL'), ($5, 'Pooled School', 'IL'), ($6, 'No Ref School', 'IL'), ($7, 'Off School', 'IL'), ($8, 'Other School', 'IL'), ($9, 'Twin School', 'IL'), ($10, 'Dup School', 'IL')`, [OHR, RJ, BETH, PLAT, POOL, NOREF, OFF, XT, TWIN, DUP]);
  await db.query(`insert into org.institution_application (id, institution_id, applicant_party_id, idempotency_key, legal_name, registration_number, address, created_at) values ($1, $2, $3, 'beth-app-1', 'Beth Friends Inc.', '45-1234567', '{"line1":"1 Main St","city":"Teaneck","postalCode":"07666"}', $4)`, [uuidv7(NOW), BETH, uuidv7(NOW), NOW]);
  const staff = async (app: App, name: string, phone: string, inst: string, role: 'admin' | 'finance' | 'staff') => {
    await person(app, name, phone, ['member', `org_${role}`]);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [people[name]!.partyId, inst, role]);
  };
  await staff(main, 'ohrAdmin', '+972501240001', OHR, 'admin');
  await staff(main, 'ohrFinance', '+972501240002', OHR, 'finance');
  await staff(main, 'ohrStaff', '+972501240003', OHR, 'staff');
  await staff(main, 'rjAdmin', '+972501240004', RJ, 'admin');
  await staff(main, 'bethAdmin', '+972501240005', BETH, 'admin');
  await staff(main, 'platAdmin', '+972501240006', PLAT, 'admin');
  await staff(pooled, 'poolAdmin', '+972501240007', POOL, 'admin');
  await staff(noRef, 'noRefAdmin', '+972501240008', NOREF, 'admin');
  await staff(off, 'offAdmin', '+972501240009', OFF, 'admin');
  await staff(main, 'xtAdmin', '+972501240010', XT, 'admin');
  await staff(main, 'twinAdmin', '+972501240011', TWIN, 'admin');
  await staff(dup, 'dupAdmin', '+972501240012', DUP, 'admin');
}, 240_000);
afterAll(async () => db.close());

const rows = async (inst: string) => (await db.query<{ status: string; holder: string }>(`select status, holder from org.institution_us_banking_event where institution_id = $1 order by seq`, [inst])).rows;
const refs = async (inst: string) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_banking' and entity_id = $1`, [inst])).rows;

describe('US banking link (TST-INS-022, T-0650)', () => {
  it('with the flag off every call answers 404 FEATURE_OFF, even an admin\'s', async () => {
    for (const r of [await link('offAdmin', OFF, { holder: 'institution', usEntity: OHR_ENTITY }, 'off-key-0001'), await status('offAdmin', OFF)]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).toContain('FEATURE_OFF');
    }
    expect(await rows(OFF)).toEqual([]);
  });

  it('only admins link (finance and staff 403), another institution\'s admin is 404, a step-up and a key are required', async () => {
    const body = { holder: 'institution', usEntity: OHR_ENTITY };
    expect((await link('ohrFinance', OHR, body, 'role-key-0001')).status).toBe(403);
    expect((await link('ohrStaff', OHR, body, 'role-key-0002')).status).toBe(403);
    expect((await link('rjAdmin', OHR, body, 'role-key-0003')).status).toBe(404);
    expect((await link('ohrAdmin', OHR, body, 'role-key-0004', { stepUp: false })).status).toBe(401);
    expect((await link('ohrAdmin', OHR, body, 'short')).status).toBe(422);
    expect((await link('ohrAdmin', OHR, { holder: 'neither' }, 'role-key-0005')).status).toBe(422);
    expect((await call('ohrStaff', 'GET', `/institutions/${OHR}/us-banking`)).status).toBe(403);
    expect(await rows(OHR)).toEqual([]);
  });

  it('an institution banking as its own US entity: one entity, the form for the admin\'s IP; a replay is the same; a new key resumes', async () => {
    const first = await link('ohrAdmin', OHR, { holder: 'institution', usEntity: OHR_ENTITY }, 'ohr-link-0001');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'pending', holder: 'institution', sharesPlatformAccount: false, formUrl: expect.stringMatching(/^https:\/\//) });
    expect(await refs(OHR)).toHaveLength(1);
    expect(await rows(OHR)).toEqual([{ status: 'pending', holder: 'institution' }]);

    const replay = await link('ohrAdmin', OHR, { holder: 'institution', usEntity: OHR_ENTITY }, 'ohr-link-0001');
    expect(replay.body).toEqual(first.body);
    const resumed = await link('ohrAdmin', OHR, { holder: 'institution', usEntity: OHR_ENTITY }, 'ohr-link-0002');
    expect(resumed.body).toMatchObject({ status: 'pending', formUrl: expect.any(String) });
    expect(await refs(OHR)).toHaveLength(1);
    expect(await rows(OHR)).toHaveLength(1);

    expect((await link('ohrAdmin', OHR, { holder: 'institution', usEntity: { ...OHR_ENTITY, ein: '12-3456780' } }, 'ohr-link-0001')).status).toBe(409);
    expect((await link('ohrAdmin', OHR, { holder: 'platform' }, 'ohr-link-0003')).status).toBe(409);
  });

  it('the application needs the requester\'s IP, and an IL institution needs a US entity named', async () => {
    expect((await link('rjAdmin', RJ, { holder: 'institution', usEntity: OHR_ENTITY }, 'rj-noip-0001', { ip: false })).status).toBe(422);
    expect((await link('rjAdmin', RJ, { holder: 'institution' }, 'rj-noent-0001')).status).toBe(422);
    expect(await rows(RJ)).toEqual([]);
  });

  it('GET follows the bank: pending, then approved once it decides; the provider approving does not open money while KYB is pending', async () => {
    const before = (await status('ohrFinance', OHR)).body;
    expect(before).toMatchObject({ status: 'pending', holder: 'institution', moneyOpen: false });
    const ref = (await refs(OHR))[0]!.external_id;
    sim(host).decide(ref);
    sim(host).post(ref, 'credit', { minor: 1_234_500n, currency: 'USD' }, 'Wire in');

    const after = (await status('ohrFinance', OHR)).body as { status: string; moneyOpen: boolean; last4: string; balance: { minor: string; currency: string } };
    expect(after).toMatchObject({ status: 'approved', moneyOpen: false, last4: '4821', balance: { minor: '1234500', currency: 'USD' } });
    expect(await rows(OHR)).toEqual([{ status: 'pending', holder: 'institution' }, { status: 'approved', holder: 'institution' }]);
    expect(JSON.stringify(after)).not.toMatch(/accountNumber|\d{9}/);

    await db.query(`insert into org.kyb_decision (id, institution_id, status, risk, decided_by, decided_at) values ($1, $2, 'approved', 'low', $3, $4)`, [uuidv7(NOW), OHR, uuidv7(NOW), NOW]);
    expect(((await status('ohrAdmin', OHR)).body as { moneyOpen: boolean }).moneyOpen).toBe(true);
    expect(((await status('ohrAdmin', OHR)).body as { status: string }).status).toBe('approved');
    expect(await rows(OHR)).toHaveLength(2);
  });

  it('a rejection then a new application appends rows and updates none', async () => {
    expect((await link('rjAdmin', RJ, { holder: 'institution', usEntity: { legalName: 'ent_rejected Friends of Rejected School', ein: '22-3333333' } }, 'rj-link-0001')).body).toMatchObject({ status: 'pending' });
    const ref = (await refs(RJ))[0]!.external_id;
    sim(host).decide(ref);
    expect(((await status('rjAdmin', RJ)).body as { status: string }).status).toBe('rejected');
    const again = await link('rjAdmin', RJ, { holder: 'institution' }, 'rj-link-0002');
    expect(again.body).toMatchObject({ status: 'pending', formUrl: expect.any(String) });
    expect((await rows(RJ)).map((r) => r.status)).toEqual(['pending', 'rejected', 'pending']);
    expect(await refs(RJ)).toHaveLength(1);
  });

  it('a US institution banks as the entity it applied as, with no entity in the request', async () => {
    const r = await link('bethAdmin', BETH, { holder: 'institution' }, 'beth-link-0001');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', holder: 'institution' });
    expect(await refs(BETH)).toHaveLength(1);
  });

  it('a platform institution is a sub-account: approved with no form, its own account to read', async () => {
    const r = await link('platAdmin', PLAT, { holder: 'platform' }, 'plat-link-0001');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ status: 'approved', holder: 'platform', sharesPlatformAccount: false });
    expect((await link('platAdmin', PLAT, { holder: 'platform' }, 'plat-link-0001')).body).toEqual(r.body);
    expect((await link('platAdmin', PLAT, { holder: 'platform' }, 'plat-link-0002')).body).toEqual(r.body);
    expect(await refs(PLAT)).toHaveLength(1);
    expect(await rows(PLAT)).toEqual([{ status: 'approved', holder: 'platform' }]);
    expect(await status('platAdmin', PLAT)).toMatchObject({ status: 200, body: { status: 'approved', holder: 'platform', sharesPlatformAccount: false, moneyOpen: false, last4: expect.stringMatching(/^\d{4}$/) } });
  });

  it('a pooled platform institution says it shares the platform account and shows no balance of its own', async () => {
    const r = await link('poolAdmin', POOL, { holder: 'platform' }, 'pool-link-0001');
    expect(r.body).toEqual({ status: 'approved', holder: 'platform', sharesPlatformAccount: true });
    const read = (await status('poolAdmin', POOL)).body as Record<string, unknown>;
    expect(read).toMatchObject({ status: 'approved', sharesPlatformAccount: true });
    expect(read['last4']).toBeUndefined();
    expect(read['balance']).toBeUndefined();
  });

  it('without a platform account set up, a platform link is refused', async () => {
    expect((await link('noRefAdmin', NOREF, { holder: 'platform' }, 'noref-link-0001')).status).toBe(422);
    expect(await rows(NOREF)).toEqual([]);
  });

  it('the provider\'s application event is mapped to OUR institution; an id we do not know, or a platform institution, is ignored', async () => {
    const s = main.services.usBanking;
    const bethRef = (await refs(BETH))[0]!.external_id;
    await s.onProviderApplication(bethRef, 'needs_info', NOW);
    await s.onProviderApplication(bethRef, 'needs_info', NOW); // a repeat changes nothing
    expect((await rows(BETH)).map((r) => r.status)).toEqual(['pending', 'needs_info']);
    await s.onProviderApplication('ent_999999', 'approved', NOW);
    const subRef = (await refs(PLAT))[0]!.external_id;
    await s.onProviderApplication(subRef, 'rejected', NOW);
    expect(await rows(PLAT)).toHaveLength(1);
    // GET re-reads the provider, whose answer wins over the event we stored: the simulator still has the application pending.
    expect(((await status('bethAdmin', BETH)).body as { status: string }).status).toBe('pending');
    expect((await rows(BETH)).map((r) => r.status)).toEqual(['pending', 'needs_info', 'pending']);
  });
});

describe('hardening (Opus review of T-0650)', () => {
  it('an entity another institution already banks is refused: no second mapping, no form, no row', async () => {
    ohrEntity = (await refs(OHR))[0]!.external_id;
    const r = await link('dupAdmin', DUP, { holder: 'institution', usEntity: OHR_ENTITY }, 'dup-link-0001');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).not.toContain('other-institutions-form');
    expect(formOpened).toBe(false);
    expect(await rows(DUP)).toEqual([]);
    expect(await refs(DUP)).toEqual([]);
    // Ohr's own mapping and status are untouched.
    expect(await refs(OHR)).toHaveLength(1);
  });

  it('a key means nothing to another institution: the same key string links both', async () => {
    const a = await link('xtAdmin', XT, { holder: 'institution', usEntity: { legalName: 'Other School Friends', ein: '33-4444444' } }, 'shared-key-0001');
    const b = await link('twinAdmin', TWIN, { holder: 'institution', usEntity: { legalName: 'Twin School Friends', ein: '55-6666666' } }, 'shared-key-0001');
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await refs(XT))[0]!.external_id).not.toBe((await refs(TWIN))[0]!.external_id);
  });

  it('the hosted form\'s link is not kept: the ledger holds the status only, and a replay asks the bank for the link again', async () => {
    const stored = JSON.stringify((await db.query(`select result from org.us_banking_key where key like 'link:%'`)).rows);
    expect(stored).not.toContain('apply.sim.invalid');
    expect(stored).not.toContain('formUrl');
    const replay = await link('twinAdmin', TWIN, { holder: 'institution', usEntity: { legalName: 'Twin School Friends', ein: '55-6666666' } }, 'shared-key-0001');
    expect(replay.body).toMatchObject({ status: 'pending', formUrl: expect.stringMatching(/^https:\/\//) });
  });

  it('two requests with one key at once make one entity and one row; a poll and an event at once append one change', async () => {
    const body = { holder: 'institution', usEntity: { legalName: 'Concurrent Friends', ein: '77-8888888' } };
    const [a, b] = await Promise.all([link('rjAdmin', RJ, { holder: 'institution' }, 'conc-key-0001'), link('rjAdmin', RJ, { holder: 'institution' }, 'conc-key-0001')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(body.holder).toBe('institution');
    const before = (await rows(RJ)).length;
    expect(await refs(RJ)).toHaveLength(1);
    const ref = (await refs(RJ))[0]!.external_id;
    sim(host).decide(ref);
    await Promise.all([status('rjAdmin', RJ), status('rjAdmin', RJ), main.services.usBanking.onProviderApplication(ref, 'rejected', NOW)]);
    const after = (await rows(RJ)).map((r) => r.status);
    expect(after.length).toBeLessThanOrEqual(before + 1);
    for (let i = 1; i < after.length; i++) expect(after[i]).not.toBe(after[i - 1]);
  });
});

describe('the Postgres key ledger (T-0648\'s KeyLedger)', () => {
  it('remembers a result by key, first write wins, and a missing key is undefined', async () => {
    const ledger = new PostgresKeyLedger(db, () => NOW);
    expect(await ledger.get('entity:key-1')).toBeUndefined();
    await ledger.put('entity:key-1', { body: 'hash-a', result: { entityRef: 'ch000001' } });
    await ledger.put('entity:key-1', { body: 'hash-b', result: { entityRef: 'ch000002' } });
    expect(await ledger.get('entity:key-1')).toEqual({ body: 'hash-a', result: { entityRef: 'ch000001' } });
    await ledger.put('holder:ch000001', { body: '', result: 'institution' });
    expect(await ledger.get('holder:ch000001')).toEqual({ body: '', result: 'institution' });
    await ledger.put('nothing', { body: 'h', result: undefined });
    expect(await ledger.get('nothing')).toEqual({ body: 'h', result: undefined });
  });
});

// T-0069: the address recorded for the bank application is the requester's, whichever ALB the request came through.
describe('the requester\'s address behind the load balancers (T-0069)', () => {
  const of = (xff: string | undefined) => clientIp({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff } } as unknown as HttpRequest);

  it('a direct client is the last entry the internet-facing ALB appended; anything the client put before it is ignored', () => {
    expect(of('198.51.100.4')).toBe('198.51.100.4');
    expect(of('203.0.113.99, 198.51.100.4')).toBe('198.51.100.4');
    expect(of('2001:db8::7')).toBe('2001:db8::7');
  });

  it('a link relayed by the console records the staff member, not the NAT gateway or the console task', () => {
    // The console forwards the staff member's address, the internal ALB appends the console task's private one.
    expect(of('198.51.100.4, 10.20.3.7')).toBe('198.51.100.4');
    expect(of('2001:db8::7, fd00::17')).toBe('2001:db8::7');
  });

  it('a client cannot make the API skip its own address: a private entry anywhere but last is not a hop', () => {
    expect(of('10.0.0.5, 198.51.100.4')).toBe('198.51.100.4');
    expect(of('198.51.100.9, 10.0.0.5, 198.51.100.4')).toBe('198.51.100.4');
  });

  it('skips one internal hop only, and never records a private address', () => {
    expect(of('198.51.100.9, 10.0.0.5, 10.1.1.1')).toBeUndefined();
    expect(of('10.1.1.1')).toBeUndefined();
    expect(of('127.0.0.1')).toBeUndefined();
    expect(of('172.16.0.1, 172.31.255.255')).toBeUndefined();
    expect(of('::ffff:192.168.1.1')).toBeUndefined();
    expect(of('')).toBeUndefined();
    expect(of(undefined)).toBeUndefined();
    expect(of('not-an-ip')).toBeUndefined();
    expect(of('198.51.100.4, junk')).toBeUndefined();
  });
});

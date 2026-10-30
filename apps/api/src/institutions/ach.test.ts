// TST-INS-009 (T-0617): a US institution's finance staff pull USD by ACH, with a step-up and an Idempotency-Key.
// A $10,000.00 pull raises the institution's holds by 1,000,000 cents and leaves what it can spend unchanged; the
// release job's path moves it only on the hold date, and the month's export reads it as a deposit; an ACH return
// during the hold reverses it with the spendable balance never touched; another institution's staff get 404; with
// `funding.ach` or `institutions.deposits` off it is FEATURE_OFF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type FundingSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey, type SigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';
import { monthlyExport } from './export.ts';
import type { AchPullView } from './ach.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
let signingKey: SigningKey;
const MONDAY = new Date('2026-11-02T09:00:00Z'); // an ACH hold of 3 business days ends Thursday
const WEDNESDAY = new Date('2026-11-04T23:59:00Z');
const THURSDAY = new Date('2026-11-05T09:00:00Z');
const INST = uuidv7(MONDAY);
const OTHER = uuidv7(MONDAY);
const IL_INST = uuidv7(MONDAY);
type Staff = { partyId: string; access: string; stepUp: string };
const staff: Record<'one' | 'other' | 'il', Staff> = { one: { partyId: '', access: '', stepUp: '' }, other: { partyId: '', access: '', stepUp: '' }, il: { partyId: '', access: '', stepUp: '' } };

const call = (who: { access: string; stepUp?: string }, method: string, url: string, body?: unknown, key?: string, on: App = app) =>
  dispatch(on, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${who.access}`, ...(who.stepUp !== undefined ? { 'x-step-up': who.stepUp } : {}), ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: MONDAY });
const pull = (who: Staff, minor: string, key: string, inst = INST, currency = 'USD') => call(who, 'POST', `/institutions/${inst}/ach-pulls`, { amount: { minor, currency }, paymentMethodId: 'pm_bank' }, key);
const balances = async () => ({ held: (await app.services.accounts.institutionHolds(INST, 'USD')).minor, available: (await app.services.accounts.institutionBalance(INST, 'USD')).minor });
const vendorLoadOf = async (transferId: string) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'transfer' and entity_id = $1`, [transferId])).rows[0]!.external_id;

/** Signs a person up with OTP and a passkey; their token carries `roles`, and they hold a fresh step-up. */
async function person(phone: string, roles: string[]): Promise<Staff> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  return { partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

/** The first app's identity store rides along, so a second app knows the same people and sessions. */
const appWith = (flags: Record<string, boolean>) => createApp({ db, registry: host.registry, market: 'US', signingKey, issuer: 'https://api.kesher.example', clock: () => MONDAY, flags: new StaticFlags(undefined, flags), ...(app ? { identity: app.services.identity } : {}) });

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost(fixedClock(MONDAY.toISOString()) as AdvanceableClock);
  signingKey = await generateSigningKey();
  app = appWith({ 'funding.ach': true, 'institutions.deposits': true });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshiva of Example', 'US'), ($2, 'Other', 'US'), ($3, 'Israeli', 'IL')`, [INST, OTHER, IL_INST]);
  for (const i of [INST, OTHER, IL_INST]) await decideKyb(db, i);
  staff.one = await person('+15555550901', ['org_finance']);
  staff.other = await person('+15555550902', ['org_finance']);
  staff.il = await person('+15555550903', ['org_finance']);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $4, 'finance'), ($2, $5, 'finance'), ($3, $6, 'finance')`, [staff.one.partyId, staff.other.partyId, staff.il.partyId, INST, OTHER, IL_INST]);
}, 60_000);
afterAll(async () => db.close());

describe('TST-INS-009 US institutions pull USD by ACH', () => {
  let held: AchPullView;

  it('a $10,000.00 pull is held until Thursday: holds rise by 1,000,000 cents and what it can spend does not; a replay is the same pull', async () => {
    const r = await pull(staff.one, '1000000', 'pull-10k-0001');
    expect(r.status).toBe(201);
    held = r.body as AchPullView;
    expect(held).toEqual({ id: expect.any(String), state: 'on_hold', amount: { minor: '1000000', currency: 'USD' }, holdUntil: '2026-11-05', createdAt: MONDAY.toISOString() });
    expect(await balances()).toEqual({ held: 1_000_000n, available: 0n });
    const again = await pull(staff.one, '1000000', 'pull-10k-0001');
    expect(again.body).toMatchObject({ id: held.id, state: 'on_hold' });
    expect(await balances()).toEqual({ held: 1_000_000n, available: 0n });
    expect((await db.query(`select 1 from audit.entry where action = 'institution.ach_pull'`)).rows).toHaveLength(1);
    expect((await call(staff.one, 'GET', `/institutions/${INST}/ach-pulls`)).body).toEqual({ items: [held], held: { minor: '1000000', currency: 'USD' }, available: { minor: '0', currency: 'USD' } });
  });

  it('released only on the hold date, into the institution\'s own account; the month\'s export reads it as a deposit', async () => {
    expect((await app.services.transfers.expiredHolds(WEDNESDAY)).map((t) => t.id)).not.toContain(held.id);
    const due = (await app.services.transfers.expiredHolds(THURSDAY)).find((t) => t.id === held.id)!;
    await app.services.loads.release(due, THURSDAY);
    expect(await balances()).toEqual({ held: 0n, available: 1_000_000n });
    expect((await call(staff.one, 'GET', `/institutions/${INST}/ach-pulls`)).body).toMatchObject({ items: [{ id: held.id, state: 'settled' }] });
    const month = await monthlyExport(db, INST, '2026-11', 'USD');
    expect(month.rows).toEqual([expect.objectContaining({ kind: 'deposit', memberPartyId: '', description: 'ACH pull from the institution\'s bank', amount: { minor: 1_000_000n, currency: 'USD' } })]);
    expect(month.totals.depositsIn.minor).toBe(1_000_000n);
  });

  it('an ACH return during the hold reverses it: the held money goes and what the institution can spend never moves', async () => {
    const r = (await pull(staff.one, '50000', 'pull-return-0001')).body as AchPullView;
    expect(await balances()).toEqual({ held: 50_000n, available: 1_000_000n });
    const w = (host.simulators.funding as FundingSimulator).webhookFor(await vendorLoadOf(r.id), 'failed');
    expect((await dispatch(app, { method: 'POST', url: '/v1/hooks/funding', headers: w.headers, rawBody: w.rawBody, now: MONDAY })).status).toBeLessThan(300);
    expect(await balances()).toEqual({ held: 0n, available: 1_000_000n });
    // Both pulls carry the test's one instant, so their order is a tie: find this one by id.
    const items = ((await call(staff.one, 'GET', `/institutions/${INST}/ach-pulls`)).body as { items: AchPullView[] }).items;
    expect(items.find((i) => i.id === r.id)).toMatchObject({ state: 'failed', failureCode: expect.any(String) });
  });

  it('another institution\'s staff get 404; no step-up is 401; a non-US institution or a non-USD amount is 422', async () => {
    expect((await pull(staff.other, '100', 'pull-other-0001')).status).toBe(404);
    expect((await call(staff.other, 'GET', `/institutions/${INST}/ach-pulls`)).status).toBe(404);
    expect((await call({ access: staff.one.access }, 'POST', `/institutions/${INST}/ach-pulls`, { amount: { minor: '100', currency: 'USD' } }, 'pull-nostepup-1')).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await pull(staff.il, '100', 'pull-il-0001', IL_INST)).body).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'not_us_institution' });
    expect((await pull(staff.one, '100', 'pull-ils-0001', INST, 'ILS')).status).toBe(422);
    expect((await pull(staff.one, '0', 'pull-zero-0001')).status).toBe(422);
  });

  it('with funding.ach or institutions.deposits off, it is FEATURE_OFF', async () => {
    for (const flags of [{ 'institutions.deposits': true }, { 'funding.ach': true }]) {
      const off = appWith(flags);
      expect((await call(staff.one, 'POST', `/institutions/${INST}/ach-pulls`, { amount: { minor: '100', currency: 'USD' } }, 'pull-off-0001', off)).body).toMatchObject({ code: 'FEATURE_OFF' });
      expect((await call(staff.one, 'GET', `/institutions/${INST}/ach-pulls`, undefined, undefined, off)).body).toMatchObject({ code: 'FEATURE_OFF' });
    }
  });
});

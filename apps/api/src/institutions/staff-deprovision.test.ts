// TST-AUTH-008 directory deprovisioning (T-0790, REQ-AUTH-008): a signed directory removal deactivates the linked staff member,
// strips the role and ends the sessions within one request; forged and stale deliveries move nothing; a repeat moves nothing; the
// last admin is removed anyway and an alert row says so; create and update events never grant; the flag is checked on the route and
// again in the processor. Beyond the card (the T-0789 review): the institution comes from the directory, a stale link never reaches
// a membership elsewhere, the database part is one transaction and a replay finishes the rest, and the unlink clock never precedes
// the link's. The org IdP is the simulator, except the signature checks, which run the WorkOS adapter's own verifier.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetrics, Secret, uuidv7 } from '@kesher/domain';
import { fixedClock, OrgIdPSimulator, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { AuditService } from '../audit/service.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { createRegistry } from '../registry.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import { directoryResolver, StaffDeprovisioner, type StaffDeprovisionDeps } from './staff-deprovision.ts';
import { StaffIdpLinks } from './staff-idp-link.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
let links: StaffIdpLinks;
const NOW = new Date('2026-11-25T10:00:00Z');
const LATER = new Date('2026-11-25T11:00:00Z');
const OHR = uuidv7(NOW);
const NER = uuidv7(NOW);
const SOLO = uuidv7(NOW);
const NOADM = uuidv7(NOW);
const SYSTEM = { actorId: '00000000-0000-7000-8000-000000000000', actorRole: 'system' };
const ORGS = Object.fromEntries([[OHR, 'ohr'], [NER, 'ner'], [SOLO, 'solo'], [NOADM, 'noadm']].map(([id, n]) => [id!, { directoryId: `dir_${n}`, scimBearer: `scim_${id}` }]));
const flagState = { on: true };
const flags: FeatureFlags = { isOn: (k) => k === 'auth.orgSso' && flagState.on, keys: () => ['auth.orgSso'] };
const lines: string[] = [];
const metrics = createMetrics({ write: (l) => lines.push(l) });
type Who = { partyId: string; access: string };
const people: Record<string, Who> = {};

/** Signs a person up (OTP and passkey) and gives them an access token with `roles`. */
async function person(name: string, phone: string, roles: string[]): Promise<void> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  people[name] = { partyId, access: (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken };
}

let phone = 972_501_240_000;
/** A signed-in staff member (token carries org_<role>) of `institution`. */
async function staffer(name: string, institution: string, role: 'admin' | 'staff'): Promise<string> {
  await person(name, `+${phone++}`, ['member', `org_${role}`]);
  await db.query('insert into org.staff (party_id, institution_id, role, active) values ($1, $2, $3, true)', [people[name]!.partyId, institution, role]);
  await app.services.identity.setUserRoles(people[name]!.partyId, ['member', `org_${role}`]);
  return people[name]!.partyId;
}
const mine = (name: string) => dispatch(app, { method: 'GET', url: '/v1/me/institution', headers: { authorization: `Bearer ${people[name]!.access}` }, rawBody: '', now: NOW });
const staffRow = async (partyId: string) => (await db.query<{ institution_id: string; active: boolean }>('select institution_id, active from org.staff where party_id = $1', [partyId])).rows[0]!;
const roles = async (name: string) => (await app.services.identity.findUser(people[name]!.partyId))?.roles ?? [];
const audits = async (action: string, subject?: string) => (await db.query<{ subject: string; payload: Record<string, unknown> }>('select subject, payload from audit.entry where action = $1 and ($2::text is null or subject = $2) order by seq', [action, subject ?? null])).rows;
const linkRows = async (partyId: string) => (await db.query<{ unlinked_at: Date | null }>('select unlinked_at from org.staff_idp_link where party_id = $1', [partyId])).rows;

const body = (eventId: string, subject: string, extra: Record<string, unknown> = {}) => ({ eventId, op: 'deactivate', subject, email: `${subject}@example.com`, directoryId: 'dir_ohr', occurredAt: NOW.toISOString(), ...extra });
const hook = (payload: unknown, headers: Record<string, string> = { 'x-sim-signature': 'sim' }, theApp: App = app, at: Date = NOW) => dispatch(theApp, { method: 'POST', url: '/v1/hooks/workos', headers, rawBody: JSON.stringify(payload), now: at });
const stored = async (eventId: string) => (await db.query<{ processed_at: Date | null; error: string | null }>("select processed_at, error from ops.inbound_event where provider = 'workos' and event_id = $1", [eventId])).rows;
const asEvent = (payload: Record<string, unknown>): InboundEvent => ({ provider: 'workos', eventId: String(payload['eventId']), receivedAt: NOW.toISOString(), signatureOk: true, payload });

class FlakyAudit extends AuditService {
  failNext = false;
  override async record(...args: Parameters<AuditService['record']>) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated crash');
    }
    return super.record(...args);
  }
}
const flaky = { audit: new FlakyAudit(undefined as never), revoke: false, role: false };
const make = (over: Partial<StaffDeprovisionDeps> = {}) =>
  new StaffDeprovisioner({
    db, audit: app.services.audit, links, team: app.services.team, tokens: app.services.tokens, flags, port: () => host.simulators['org-idp'], mode: () => 'sim',
    directories: directoryResolver(ORGS), notify: host.simulators.notify, alertTo: 'ops@kesher.example', metrics, now: () => NOW, ...over,
  });
const crashy = (): Partial<StaffDeprovisionDeps> => ({
  tokens: { revokeAll: async (p, r) => { if (flaky.revoke) { flaky.revoke = false; throw new Error('simulated crash'); } return app.services.tokens.revokeAll(p, r); } },
  team: { deactivate: (...a) => app.services.team.deactivate(...a), clearOrgRole: async (p) => { if (flaky.role) { flaky.role = false; throw new Error('simulated crash'); } return app.services.team.clearOrgRole(p); } },
});

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  host.simulators['org-idp'] = new OrgIdPSimulator(host.clock, [OHR, NER, SOLO, NOADM]);
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags, orgIdp: { orgs: ORGS, staffAlertEmail: 'ops@kesher.example' } });
  links = new StaffIdpLinks({ db, audit: app.services.audit });
  flaky.audit = new FlakyAudit(db);
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Beit Ner', 'IL'), ($3, 'Solo School', 'IL'), ($4, 'No Admin School', 'IL')`, [OHR, NER, SOLO, NOADM]);
  await staffer('rivka', OHR, 'admin');
}, 120_000);
afterAll(async () => db.close());

describe('directory deprovisioning (TST-AUTH-008, T-0790)', () => {
  it('(1) a signed deactivation deactivates, strips the role, ends the sessions and audits once, in one request', async () => {
    const avi = await staffer('avi', OHR, 'staff');
    await links.link(OHR, 'idp-avi', avi, SYSTEM, NOW);
    expect((await mine('avi')).status).toBe(200);
    expect(await roles('avi')).toContain('org_staff');
    const r = await hook(body('evt-avi-1', 'idp-avi'));
    expect(r.status).toBe(200);
    expect(await staffRow(avi)).toMatchObject({ institution_id: OHR, active: false });
    expect(await roles('avi')).not.toContain('org_staff');
    expect((await mine('avi')).status).toBe(401);
    const a = await audits('institution.staff.deprovision', avi);
    expect(a).toHaveLength(1);
    expect(a[0]!.payload).toMatchObject({ institutionId: OHR, eventId: 'evt-avi-1', removed: true });
    expect((await linkRows(avi))[0]!.unlinked_at).not.toBeNull();
    expect((await stored('evt-avi-1'))[0]!.processed_at).not.toBeNull();
  });

  it('(3) the same event id twice moves nothing the second time', async () => {
    const before = (await db.query<{ n: number }>('select count(*)::int as n from audit.entry')).rows[0]!.n;
    const again = await hook(body('evt-avi-1', 'idp-avi'));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true });
    // and the processor itself, run again on the same event, changes nothing
    await make().process(asEvent(body('evt-avi-1', 'idp-avi')));
    expect((await db.query<{ n: number }>('select count(*)::int as n from audit.entry')).rows[0]!.n).toBe(before);
    expect(await audits('institution.staff.deprovision', people['avi']!.partyId)).toHaveLength(1);
  });

  it('(4) an unknown subject, an unlinked staff member and an unknown directory are no-ops, 200', async () => {
    const eli = await staffer('eli', OHR, 'staff');
    const fay = await staffer('fay', OHR, 'staff');
    await links.link(OHR, 'idp-fay', fay, SYSTEM, NOW);
    const before = (await db.query<{ n: number }>('select count(*)::int as n from audit.entry')).rows[0]!.n;
    expect((await hook(body('evt-nobody', 'idp-nobody'))).status).toBe(200);
    expect((await hook(body('evt-eli', 'idp-eli'))).status).toBe(200);
    expect((await hook(body('evt-dir', 'idp-eli', { directoryId: 'dir_elsewhere' }))).status).toBe(200);
    // a linked member whose subject arrives under an unknown directory, or under another institution's, is not touched
    expect((await hook(body('evt-fay-1', 'idp-fay', { directoryId: 'dir_elsewhere' }))).status).toBe(200);
    expect((await hook(body('evt-fay-2', 'idp-fay', { directoryId: 'dir_ner' }))).status).toBe(200);
    expect(await staffRow(fay)).toMatchObject({ active: true });
    expect(await links.find(OHR, 'idp-fay')).toBe(fay);
    // an unknown directory is a CLEAN no-op: stored, processed, no error
    expect((await stored('evt-fay-1'))[0]).toMatchObject({ processed_at: expect.any(Date), error: null });
    expect(await staffRow(eli)).toMatchObject({ active: true });
    expect((await mine('eli')).status).toBe(200);
    expect((await db.query<{ n: number }>('select count(*)::int as n from audit.entry')).rows[0]!.n).toBe(before);
  });

  it('(5) the last active admin is deprovisioned anyway; the alert row exists and Kesher staff are told once', async () => {
    const sole = await staffer('sole', SOLO, 'admin');
    await links.link(SOLO, 'idp-sole', sole, SYSTEM, NOW);
    expect((await hook(body('evt-sole', 'idp-sole', { directoryId: 'dir_solo' }))).status).toBe(200);
    expect(await staffRow(sole)).toMatchObject({ active: false });
    expect((await mine('sole')).status).toBe(401);
    const none = await audits('institution.admin.none', SOLO);
    expect(none).toHaveLength(1);
    expect(none[0]!.payload).toMatchObject({ institutionId: SOLO, eventId: 'evt-sole' });
    const sent = host.simulators.notify.sent.filter((n) => n.to === 'ops@kesher.example' && n.template === 'institution.admin_none');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.data)).not.toContain('idp-sole');
    // an admin who is not the last raises no alert
    const second = await staffer('second', OHR, 'admin');
    await links.link(OHR, 'idp-second', second, SYSTEM, NOW);
    await hook(body('evt-second', 'idp-second'));
    expect(await staffRow(second)).toMatchObject({ active: false });
    expect(await audits('institution.admin.none', OHR)).toHaveLength(0);
  });

  it('(6) create and update events never create or raise staff; (c) a create for a new subject while the old link is live is a no-op', async () => {
    const nov = await staffer('nov', OHR, 'staff');
    await links.link(OHR, 'idp-old', nov, SYSTEM, NOW);
    const staffBefore = (await db.query('select * from org.staff order by party_id')).rows;
    const linksBefore = (await db.query('select * from org.staff_idp_link order by id')).rows;
    for (const [id, op, subject] of [['evt-c1', 'create', 'idp-new'], ['evt-c2', 'create', 'idp-brand-new'], ['evt-c3', 'update', 'idp-old'], ['evt-c4', 'create', 'idp-old']] as const) {
      const r = await hook(body(id, subject, { op, active: true }));
      expect(r.status).toBe(200);
    }
    expect((await db.query('select * from org.staff order by party_id')).rows).toEqual(staffBefore);
    expect((await db.query('select * from org.staff_idp_link order by id')).rows).toEqual(linksBefore);
    expect(await links.find(OHR, 'idp-old')).toBe(nov);
    expect(await links.find(OHR, 'idp-new')).toBeUndefined();
    expect((await mine('nov')).status).toBe(200);
    // the later removal of the old subject still works
    await hook(body('evt-c5', 'idp-old'));
    expect(await staffRow(nov)).toMatchObject({ active: false });
  });

  it('(7) flag off: the route answers 404 and the event is not stored; turned off after boot, the processor leaves the event pending', async () => {
    const lia = await staffer('lia', OHR, 'staff');
    await links.link(OHR, 'idp-lia', lia, SYSTEM, NOW);
    flagState.on = false;
    const off = await hook(body('evt-off', 'idp-lia'));
    expect(off.status).toBe(404);
    expect(await stored('evt-off')).toHaveLength(0);
    // received while on, flag turned off before it was applied
    flagState.on = true;
    await app.services.inbound.record({ provider: 'workos', eventId: 'evt-late', signatureOk: true, payload: body('evt-late', 'idp-lia'), receivedAt: NOW });
    flagState.on = false;
    expect(await app.services.webhooks.replay({ provider: 'workos', now: NOW })).toMatchObject({ succeeded: 0 });
    expect(await staffRow(lia)).toMatchObject({ active: true });
    expect((await stored('evt-late'))[0]!.processed_at).toBeNull();
    flagState.on = true;
    expect(await app.services.webhooks.replay({ provider: 'workos', now: NOW })).toMatchObject({ succeeded: 1 });
    expect(await staffRow(lia)).toMatchObject({ active: false });
  });

  it('(8) an event older than 15 minutes at processing is metered as staff.deprovision_lag_s; a fresh one is not', async () => {
    const zed = await staffer('zed', OHR, 'staff');
    const yan = await staffer('yan', OHR, 'staff');
    await links.link(OHR, 'idp-zed', zed, SYSTEM, NOW);
    await links.link(OHR, 'idp-yan', yan, SYSTEM, NOW);
    lines.length = 0;
    await make().process(asEvent(body('evt-lag-ok', 'idp-yan', { occurredAt: new Date(NOW.getTime() - 14 * 60_000).toISOString() })));
    expect(lines.filter((l) => l.includes('staff.deprovision_lag_s'))).toHaveLength(0);
    await make().process(asEvent(body('evt-lag', 'idp-zed', { occurredAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() })));
    const metered = lines.filter((l) => l.includes('staff.deprovision_lag_s')).map((l) => JSON.parse(l) as Record<string, number>);
    expect(metered).toHaveLength(1);
    expect(metered[0]!['staff.deprovision_lag_s']).toBe(1200);
    expect(await staffRow(zed)).toMatchObject({ active: false });
  });

  it('(a) the institution is the event\'s: a stale live link at Ohr never deactivates a party now active staff of Ner', async () => {
    const tal = await staffer('tal', OHR, 'staff');
    await links.link(OHR, 'idp-tal', tal, SYSTEM, NOW);
    // Tal leaves Ohr and starts at Ner; the Ohr link is left live.
    await db.query(`update org.staff set institution_id = $2, role = 'staff' where party_id = $1`, [tal, NER]);
    expect(await links.find(OHR, 'idp-tal')).toBe(tal);
    const r = await hook(body('evt-tal', 'idp-tal'));
    expect(r.status).toBe(200);
    expect(await staffRow(tal)).toMatchObject({ institution_id: NER, active: true });
    expect(await roles('tal')).toContain('org_staff');
    expect((await mine('tal')).status).toBe(200);
    expect(await links.find(OHR, 'idp-tal')).toBeUndefined(); // the stale link is ended and audited
    expect((await audits('institution.staff.deprovision', tal))[0]!.payload).toMatchObject({ removed: false });
    expect(await app.services.team.deactivate(OHR, tal)).toBe(false); // the shared removal body is institution-scoped on its own
    expect(await staffRow(tal)).toMatchObject({ institution_id: NER, active: true });
    // the same subject text at Ner's directory finds nothing at Ner: no link there
    await hook(body('evt-tal-2', 'idp-tal', { directoryId: 'dir_ner' }));
    expect(await staffRow(tal)).toMatchObject({ institution_id: NER, active: true });
  });

  it('(b) a crash after the commit leaves the removal done; the replay finishes sessions and role, once', async () => {
    const mo = await staffer('mo', OHR, 'staff');
    await links.link(OHR, 'idp-mo', mo, SYSTEM, NOW);
    const p = make(crashy());
    flaky.revoke = true;
    await expect(p.process(asEvent(body('evt-mo', 'idp-mo')))).rejects.toThrow('simulated crash');
    expect(await staffRow(mo)).toMatchObject({ active: false });
    expect(await audits('institution.staff.deprovision', mo)).toHaveLength(1);
    expect(await linkRows(mo)).toEqual([{ unlinked_at: expect.any(Date) }]);
    expect((await mine('mo')).status).not.toBe(401); // the old token still lives until the replay
    await p.process(asEvent(body('evt-mo', 'idp-mo')));
    expect((await mine('mo')).status).toBe(401);
    expect(await roles('mo')).not.toContain('org_staff');
    expect(await audits('institution.staff.deprovision', mo)).toHaveLength(1);
    // a crash before the role is stripped, replayed through the real route and the replay tool
    const na = await staffer('na', OHR, 'staff');
    await links.link(OHR, 'idp-na', na, SYSTEM, NOW);
    flaky.role = true;
    await expect(make(crashy()).process(asEvent(body('evt-na', 'idp-na')))).rejects.toThrow('simulated crash');
    expect(await roles('na')).toContain('org_staff');
    await make(crashy()).process(asEvent(body('evt-na', 'idp-na')));
    expect(await roles('na')).not.toContain('org_staff');
    expect((await mine('na')).status).toBe(401);
    expect(await audits('institution.staff.deprovision', na)).toHaveLength(1);
  });

  it('(b) a crash inside the transaction leaves nothing: row, audit and link roll back together, and a retry completes', async () => {
    const ka = await staffer('ka', OHR, 'staff');
    await links.link(OHR, 'idp-ka', ka, SYSTEM, NOW);
    flaky.audit.failNext = true;
    await expect(make({ audit: flaky.audit }).process(asEvent(body('evt-ka', 'idp-ka')))).rejects.toThrow('simulated crash');
    expect(await staffRow(ka)).toMatchObject({ active: true });
    expect(await audits('institution.staff.deprovision', ka)).toHaveLength(0);
    expect(await links.find(OHR, 'idp-ka')).toBe(ka);
    expect((await mine('ka')).status).toBe(200);
    await make().process(asEvent(body('evt-ka', 'idp-ka')));
    expect(await staffRow(ka)).toMatchObject({ active: false });
    expect(await audits('institution.staff.deprovision', ka)).toHaveLength(1);
    expect((await mine('ka')).status).toBe(401);
  });

  it('(b) a replay never strips a person who has since become active staff elsewhere', async () => {
    const ra = await staffer('ra', OHR, 'staff');
    await links.link(OHR, 'idp-ra', ra, SYSTEM, NOW);
    flaky.role = true;
    const p = make(crashy());
    await expect(p.process(asEvent(body('evt-ra', 'idp-ra')))).rejects.toThrow('simulated crash');
    await db.query(`update org.staff set institution_id = $2, active = true where party_id = $1`, [ra, NER]); // hired by Ner before the replay
    await p.process(asEvent(body('evt-ra', 'idp-ra')));
    expect(await staffRow(ra)).toMatchObject({ institution_id: NER, active: true });
    expect(await roles('ra')).toContain('org_staff');
    expect((await mine('ra')).status).toBe(200);
  });

  it('(d) a link dated after the event is still unlinked (the clock never precedes linked_at)', async () => {
    const clk = await staffer('clk', OHR, 'staff');
    await links.link(OHR, 'idp-clk', clk, SYSTEM, LATER);
    await hook(body('evt-clk', 'idp-clk'));
    expect(await staffRow(clk)).toMatchObject({ active: false });
    const row = (await db.query<{ linked_at: Date; unlinked_at: Date }>('select linked_at, unlinked_at from org.staff_idp_link where party_id = $1', [clk])).rows[0]!;
    expect(row.unlinked_at.getTime()).toBe(LATER.getTime());
  });

  it('a stale signature is told apart from a forged one (the rejection reason metric)', async () => {
    const v = make({ mode: () => 'sandbox', port: () => ({ verifyWebhookSignature: () => false }) as never }).verifier();
    const raw = JSON.stringify({ id: 'evt-x' });
    const t = (at: Date) => `t=${Math.floor(at.getTime() / 1000)}, v1=ab`;
    expect(await v.verify({ 'WorkOS-Signature': t(new Date(NOW.getTime() - 6 * 60_000)) }, raw, NOW)).toMatchObject({ ok: false, eventId: 'evt-x', reason: 'stale timestamp' });
    expect(await v.verify({ 'WorkOS-Signature': t(NOW) }, raw, NOW)).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  it('N3: an event the adapter refuses moves nothing, is counted by reason, and is left errored and pending (HTTP stays 200), never a silent drop', async () => {
    const bea = await staffer('bea', OHR, 'staff');
    await links.link(OHR, 'idp-bea', bea, SYSTEM, NOW);
    lines.length = 0;
    const bad = make({ directories: directoryResolver({ [OHR]: { directoryId: 'dir_ohr', scimBearer: 'wrong' } }) });
    await expect(bad.process(asEvent(body('evt-bea', 'idp-bea')))).rejects.toThrow('scim_unauthorized');
    expect(await staffRow(bea)).toMatchObject({ active: true });
    const m = lines.filter((l) => l.includes('staff.deprovision_refused')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(m).toEqual([expect.objectContaining({ reason: 'scim_unauthorized', 'staff.deprovision_refused': 1 })]);
    // through the route: 200, and the stored event carries the reason, unprocessed
    const malformed = await hook({ eventId: 'evt-bad-shape', directoryId: 'dir_ohr', op: 'nonsense' });
    expect(malformed.status).toBe(200);
    expect((await stored('evt-bad-shape'))[0]).toMatchObject({ processed_at: null, error: expect.stringContaining('scim_malformed') });
    // two institutions claiming one directory resolve to nothing
    expect(directoryResolver({ a: { directoryId: 'd', scimBearer: 'x' }, b: { directoryId: 'd', scimBearer: 'y' } })('d')).toBeUndefined();
  });

  it('F1: a concurrent delivery whose twin committed but failed to finish does not swallow the event: it finishes, or stays unprocessed for replay', async () => {
    for (const bFails of [false, true]) {
      const name = bFails ? 'racef' : 'racet';
      const id = await staffer(name, OHR, 'staff');
      await links.link(OHR, `idp-${name}`, id, SYSTEM, NOW);
      const ev = asEvent(body(`evt-${name}`, `idp-${name}`));
      let release = (): void => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let reached = (): void => undefined;
      const atGate = new Promise<void>((r) => (reached = r));
      // B has already found the live link when A commits
      const B = make({ ...(bFails ? crashy() : {}), links: { find: async (...a) => { const r = await links.find(...a); reached(); await gate; return r; } } });
      const bRun = B.process(ev).then(() => 'ok', (e: Error) => e.message);
      await atGate;
      flaky.revoke = true;
      await expect(make(crashy()).process(ev)).rejects.toThrow('simulated crash'); // A: committed, finish threw
      expect((await mine(name)).status).not.toBe(401);
      if (bFails) flaky.revoke = true;
      release();
      const outcome = await bRun;
      if (!bFails) {
        expect(outcome).toBe('ok');
        expect((await mine(name)).status).toBe(401);
        expect(await roles(name)).not.toContain('org_staff');
      } else {
        expect(outcome).toBe('simulated crash'); // B throws, so the router leaves the event unprocessed and the replay retries
        await make().process(ev);
        expect((await mine(name)).status).toBe(401);
      }
      expect(await audits('institution.staff.deprovision', id)).toHaveLength(1);
    }
  }, 30_000);

  it('F2a: the same subject text live at two institutions: an event for one never touches the other', async () => {
    const y = await staffer('dupy', NER, 'staff');
    await links.link(NER, 'idp-dup', y, SYSTEM, NOW); // linked first, so an unscoped lookup would meet it first
    const x = await staffer('dupx', OHR, 'staff');
    await links.link(OHR, 'idp-dup', x, SYSTEM, NOW);
    await make().process(asEvent(body('evt-dup', 'idp-dup')));
    expect(await staffRow(x)).toMatchObject({ active: false });
    expect(await staffRow(y)).toMatchObject({ active: true });
    expect(await links.find(NER, 'idp-dup')).toBe(y);
    expect((await mine('dupy')).status).toBe(200);
  });

  it('F2b: the replay lookup is per institution: the same event id seen for another institution is its own work', async () => {
    const a = await staffer('shra', OHR, 'staff');
    const b = await staffer('shrb', NER, 'staff');
    await links.link(OHR, 'idp-shr', a, SYSTEM, NOW);
    await links.link(NER, 'idp-shr', b, SYSTEM, NOW);
    await make().process(asEvent(body('evt-shared', 'idp-shr')));
    await make().process(asEvent(body('evt-shared', 'idp-shr', { directoryId: 'dir_ner' })));
    expect(await staffRow(a)).toMatchObject({ active: false });
    expect(await staffRow(b)).toMatchObject({ active: false });
  });

  it('F2c: removing a non-admin from an institution that has no admin raises no institution.admin.none', async () => {
    const n = await staffer('noadm', NOADM, 'staff');
    await links.link(NOADM, 'idp-noadm', n, SYSTEM, NOW);
    await make().process(asEvent(body('evt-noadm', 'idp-noadm', { directoryId: 'dir_noadm' })));
    expect(await staffRow(n)).toMatchObject({ active: false });
    expect(await audits('institution.admin.none', NOADM)).toHaveLength(0);
  });

  it('F2d: with no alert address configured the last admin is still removed and audited, and nobody is messaged', async () => {
    const adm = await staffer('lonely', NOADM, 'admin');
    await links.link(NOADM, 'idp-lonely', adm, SYSTEM, NOW);
    const before = host.simulators.notify.sent.length;
    await make({ alertTo: undefined }).process(asEvent(body('evt-lonely', 'idp-lonely', { directoryId: 'dir_noadm' })));
    expect(await staffRow(adm)).toMatchObject({ active: false });
    expect(await audits('institution.admin.none', NOADM)).toHaveLength(1);
    expect(host.simulators.notify.sent.length).toBe(before);
  });

});

describe('directory deprovisioning with the WorkOS verifier (TST-AUTH-008, T-0790)', () => {
  let wapp: App;
  let clock: AdvanceableClock;
  const WOH = uuidv7(NOW);
  const SECRET = 'whsec_directory_test';
  const sign = (raw: string, at: Date) => {
    const t = Math.floor(at.getTime() / 1000);
    return `t=${t}, v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;
  };
  const dsync = (id: string, event: string, idp: string, state = 'inactive') => ({ id, event, created_at: NOW.toISOString(), data: { id: 'directory_user_1', idp_id: idp, organization_id: 'org_workos_woh', directory_id: 'directory_woh', emails: [{ primary: true, value: `${idp}@example.com` }], state } });
  const post = (payload: unknown, header: string | undefined) => hook(payload, header ? { 'workos-signature': header } : {}, wapp);

  beforeAll(async () => {
    clock = fixedClock(NOW.toISOString()) as AdvanceableClock;
    const { registry } = createRegistry('sandbox', clock, { orgIdp: { provider: 'workos', clientId: new Secret('client_woh'), apiKey: new Secret('sk_woh'), webhookSecret: new Secret(SECRET), orgs: { [WOH]: { workosOrganizationId: 'org_workos_woh', directoryId: 'directory_woh', scimBearer: 'bearer-woh' } } } });
    wapp = createApp({ db, registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags, orgIdp: { orgs: { [WOH]: { directoryId: 'directory_woh', scimBearer: 'bearer-woh' } } } });
    await db.query(`insert into org.institution (id, name, market) values ($1, 'WorkOS School', 'IL')`, [WOH]);
  }, 60_000);

  const seedStaff = async (idp: string) => {
    const id = uuidv7(NOW);
    await db.query('insert into org.staff (party_id, institution_id, role, active) values ($1, $2, $3, true)', [id, WOH, 'staff']);
    await new StaffIdpLinks({ db, audit: wapp.services.audit }).link(WOH, idp, id, SYSTEM, NOW);
    return id;
  };

  it('(2) a forged signature, a missing one and one older than 5 minutes answer 401 and nothing moves; a good one deactivates', async () => {
    const wid = await seedStaff('idp-w1');
    const payload = dsync('evt-w1', 'dsync.user.deleted', 'idp-w1');
    const raw = JSON.stringify(payload);
    expect((await post(payload, `t=${Math.floor(NOW.getTime() / 1000)}, v1=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await post(payload, undefined)).status).toBe(401);
    expect((await post(payload, sign(raw, new Date(NOW.getTime() - 6 * 60_000)))).status).toBe(401);
    expect(await staffRow(wid)).toMatchObject({ active: true });
    expect(await stored('evt-w1')).toHaveLength(0); // refused deliveries claim nothing
    expect((await post(payload, sign(raw, NOW))).status).toBe(200);
    expect(await staffRow(wid)).toMatchObject({ institution_id: WOH, active: false });
    expect(await audits('institution.staff.deprovision', wid)).toHaveLength(1);
  });

  it('dsync.user.updated with the user inactive deprovisions; active, created and an organisation mismatch do not', async () => {
    const wid = await seedStaff('idp-w2');
    const send = (p: unknown) => post(p, sign(JSON.stringify(p), NOW));
    expect((await send(dsync('evt-w2a', 'dsync.user.updated', 'idp-w2', 'active'))).status).toBe(200);
    expect((await send(dsync('evt-w2b', 'dsync.user.created', 'idp-w2', 'active'))).status).toBe(200);
    const foreign = dsync('evt-w2c', 'dsync.user.deleted', 'idp-w2');
    foreign.data.organization_id = 'org_workos_other';
    expect((await send(foreign)).status).toBe(200);
    expect(await staffRow(wid)).toMatchObject({ active: true });
    expect((await send(dsync('evt-w2d', 'dsync.user.updated', 'idp-w2', 'inactive'))).status).toBe(200);
    expect(await staffRow(wid)).toMatchObject({ active: false });
  });
});

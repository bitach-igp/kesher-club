// T-0791 directory drift sweep (TST-AUTH-008, REQ-AUTH-008), against the simulator org IdP (SimulatorHost, no network):
// (1) a linked member the directory lists inactive goes through the shared removal and a second sweep changes nothing; (2) one the
// directory no longer lists goes too, flagged drift_missing; (3) unlinked directory users change nothing and are counted; (4) an
// outage, an empty list, a malformed entry or a mass removal never reads as "everyone left"; (5) flag off, flag service down and no
// binding do nothing; (6) staff.drift_corrected is emitted. Beyond the card, from the T-0790 reviews: (a) a stale link never reaches
// another institution, (b) the institution comes from the per-organisation record, (d) one bad institution never starves the rest,
// (e) the unlink clock, (f) no PII in the audit payload, (h) one list call per institution per cycle and a nightly unlinked count.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetrics, uuidv7 } from '@kesher/domain';
import { fixedClock, OrgIdPError, type NotifyPort, OrgIdPSimulator, SIM_OTP_CODE, SimPasskeyDevice, type OrgIdPPort } from '@kesher/ports';
import { createRegistry } from '@kesher/api/registry';
import { createApp, type App } from '@kesher/api/app';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import type { FeatureFlags } from '@kesher/api/billing/capabilities';
import { dispatch } from '@kesher/api/server';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { directoryInstitutions, removalKey, StaffDeprovisioner } from '@kesher/api/institutions/staff-deprovision';
import { putMarker } from '@kesher/api/ops/workflow-marker';
import { StaffIdpLinks } from '@kesher/api/institutions/staff-idp-link';
import { DirectoryDrift, DRIFT_REFUSAL_REASONS, DriftCycleFailed, type DirectoryDriftDeps, type DriftResult } from './directory-drift.ts';

let db: TestDatabase;
let app: App;
let links: StaffIdpLinks;
let notify: NotifyPort;
const sim = new OrgIdPSimulator(fixedClock(), []);
const NOW = new Date('2026-11-25T10:00:00Z');
/** Links made two days ago: past the 24 hour grace for absence. */
const OLD = new Date(NOW.getTime() - 48 * 3_600_000);
let now = NOW;
const SYSTEM = { actorId: '00000000-0000-7000-8000-000000000000', actorRole: 'system' };
const flagState: { on: boolean; throws: boolean; budget: number | undefined } = { on: true, throws: false, budget: undefined };
/** `budget` is how many reads answer on; the next ones answer off (a flag turned off mid-cycle). */
const flags: FeatureFlags = { isOn: async (k) => { if (flagState.throws) throw new Error('flag service down'); if (flagState.budget !== undefined && flagState.budget-- <= 0) return false; return k === 'auth.orgSso' && flagState.on; }, keys: () => ['auth.orgSso'] };
const lines: string[] = [];
const metrics = createMetrics({ write: (l) => lines.push(l) });
const metric = (name: string, reason?: string): number => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => name in m && (reason === undefined || m['reason'] === reason)).reduce((n, m) => n + (m[name] as number), 0);

const calls: string[] = [];
let listing: ((org: string) => Promise<unknown>) | undefined;
const port: OrgIdPPort = {
  startSso: (...a) => sim.startSso(...a),
  handleCallback: (...a) => sim.handleCallback(...a),
  parseScimEvent: (...a) => sim.parseScimEvent(...a),
  listDirectory: async (org) => {
    calls.push(org);
    return (listing ? listing(org) : sim.listDirectory(org)) as never;
  },
};

type Who = { partyId: string; access: string };
const people: Record<string, Who> = {};
let phone = 972_502_000_000;
async function staffer(name: string, institution: string): Promise<string> {
  const s = app.services;
  const p = `+${phone++}`;
  const started = await s.otp.start({ phone: p, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${p}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${p}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  people[name] = { partyId, access: (await s.tokens.issue({ partyId, deviceId: `web-${p}`, roles: ['member', 'org_staff'] })).accessToken };
  await db.query('insert into org.staff (party_id, institution_id, role, active) values ($1, $2, $3, true)', [partyId, institution, 'staff']);
  await s.identity.setUserRoles(partyId, ['member', 'org_staff']);
  return partyId;
}
const mine = (name: string) => dispatch(app, { method: 'GET', url: '/v1/me/institution', headers: { authorization: `Bearer ${people[name]!.access}` }, rawBody: '', now: NOW });
const live = async (name: string) => (await mine(name)).status !== 401;
const roles = async (name: string) => (await app.services.identity.findUser(people[name]!.partyId))?.roles ?? [];
const active = async (name: string) => (await db.query<{ active: boolean }>('select active from org.staff where party_id = $1', [people[name]!.partyId])).rows.map((r) => r.active);
const auditRows = async (action: string) => (await db.query<{ subject: string; payload: Record<string, unknown> }>('select subject, payload from audit.entry where action = $1 order by seq', [action])).rows;
const auditCount = async () => (await db.query<{ n: number }>('select count(*)::int as n from audit.entry')).rows[0]!.n;

let n = 0;
const ORGS: Record<string, { directoryId: string; scimBearer: string }> = {};
/** A new institution with a directory; `names` are staff linked as idp-<name> (and put in the directory when `listed`). */
async function institution(names: string[], listed: 'all' | 'none' = 'all'): Promise<string> {
  const id = uuidv7(NOW);
  n += 1;
  ORGS[id] = { directoryId: `dir_${n}`, scimBearer: `scim_${id}` };
  (sim as unknown as { directory: Map<string, Map<string, unknown>> }).directory.set(id, new Map());
  await db.query(`insert into org.institution (id, name, market) values ($1, $2, 'IL')`, [id, `School ${n}`]);
  for (const name of names) {
    const party = await staffer(`${id}-${name}`, id);
    people[name + id] = people[`${id}-${name}`]!;
    await links.link(id, `idp-${name}`, party, SYSTEM, OLD);
    if (listed === 'all') await dir(id, name, true);
  }
  return id;
}
let ev = 0;
const dir = (inst: string, name: string, isActive: boolean) => sim.parseScimEvent(inst, `scim_${inst}`, { eventId: `e${ev++}`, op: isActive ? 'create' : 'deactivate', subject: `idp-${name}`, email: `${name}@example.com` });
const who = (inst: string, name: string) => `${inst}-${name}`;

const deprovisioner = (insts: string[], over: Partial<ConstructorParameters<typeof StaffDeprovisioner>[0]> = {}) =>
  new StaffDeprovisioner({ db, audit: app.services.audit, links, team: app.services.team, tokens: app.services.tokens, flags, port: () => port, mode: () => 'sim', directories: () => undefined, notify, metrics, now: () => now, institutions: insts, ...over });
const job = (insts: string[], over: Partial<DirectoryDriftDeps> = {}) => new DirectoryDrift({ db, audit: app.services.audit, flags, port: () => port, deprovision: deprovisioner(insts), metrics, clock: () => now, ...over });

beforeAll(async () => {
  db = await createTestDatabase();
  const { registry } = createRegistry('sim');
  notify = registry.resolve<NotifyPort>('notify', 'IL');
  app = createApp({ db, registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags, orgIdp: { orgs: ORGS } });
  links = new StaffIdpLinks({ db, audit: app.services.audit });
}, 120_000);
afterAll(async () => db.close());

const reset = () => {
  now = NOW;
  calls.length = 0;
  listing = undefined;
  flagState.on = true;
  flagState.throws = false;
  flagState.budget = undefined;
  lines.length = 0;
};

describe('directory drift sweep (TST-AUTH-008, T-0791)', () => {
  it('(1) a member the directory lists inactive is removed through the shared path; a second sweep changes nothing', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    expect((await mine(who(I, 'a'))).status).toBe(200);
    const r = await job([I]).run();
    expect(r).toMatchObject({ corrected: 1, refused: 0, failed: 0 });
    expect(await active(who(I, 'a'))).toEqual([false]);
    expect(await roles(who(I, 'a'))).not.toContain('org_staff');
    expect((await mine(who(I, 'a'))).status).toBe(401);
    expect(await active(who(I, 'b'))).toEqual([true]);
    const a = (await auditRows('institution.staff.deprovision')).filter((x) => x.payload['institutionId'] === I);
    expect(a).toHaveLength(1);
    expect(a[0]!.payload).toMatchObject({ source: 'drift', drift_missing: false, removed: true });
    expect(metric('staff.drift_corrected', 'inactive')).toBe(1);
    const before = await auditCount();
    expect(await job([I]).run()).toMatchObject({ corrected: 0, failed: 0 });
    expect(await auditCount()).toBe(before);
  });

  it('(2) a member absent from the list is removed and flagged drift_missing; the audit payload carries no email or subject (f)', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    (sim as unknown as { directory: Map<string, Map<string, unknown>> }).directory.get(I)!.delete('idp-d');
    expect(await job([I]).run()).toMatchObject({ corrected: 1 });
    expect(await active(who(I, 'd'))).toEqual([false]);
    expect((await mine(who(I, 'd'))).status).toBe(401);
    const a = (await auditRows('institution.staff.deprovision')).find((x) => x.payload['institutionId'] === I)!;
    expect(a.payload).toMatchObject({ drift_missing: true, source: 'drift' });
    expect(JSON.stringify(a)).not.toMatch(/@|idp-d|example\.com/);
    expect(metric('staff.drift_corrected', 'missing')).toBe(1);
  });

  it('(3) directory users with no link, active or inactive, change nothing and are only counted', async () => {
    reset();
    const I = await institution(['a', 'b']);
    await dir(I, 'ghost1', true);
    await dir(I, 'ghost2', false);
    const before = await auditCount();
    expect(await job([I]).run()).toMatchObject({ corrected: 0, unlinked: 2, refused: 0 });
    expect(await auditCount()).toBe(before);
    expect(await active(who(I, 'a'))).toEqual([true]);
  });

  it('(4) PROVIDER_UNAVAILABLE changes nothing and fails the cycle, after the other institutions are swept (d)', async () => {
    reset();
    const bad = await institution(['a', 'b', 'c']);
    const good = await institution(['a', 'b', 'c', 'd']);
    await dir(good, 'a', false);
    listing = async (org) => {
      if (org === bad) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'down');
      return sim.listDirectory(org);
    };
    const e = await job([bad, good]).run().then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(DriftCycleFailed);
    expect((e as DriftCycleFailed).result).toMatchObject({ failed: 1, corrected: 1 });
    expect(await active(who(bad, 'a'))).toEqual([true]);
    expect(await active(who(good, 'a'))).toEqual([false]);
    expect(metric('staff.drift_refused', 'provider_unavailable')).toBe(1);
  });

  it('(4) a list that fails part-way (a later page) is a failed read, never a short list', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd', 'e', 'f']);
    listing = async () => { throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'page 2 failed'); };
    await expect(job([I]).run()).rejects.toBeInstanceOf(DriftCycleFailed);
    for (const x of ['a', 'b', 'c', 'd', 'e', 'f']) expect(await active(who(I, x))).toEqual([true]);
  });

  it('(4) an empty list, or one with no active entry, is never read as everyone left: absence is switched off', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    listing = async () => [];
    expect(await job([I]).run()).toMatchObject({ corrected: 0, refused: 0, failed: 0 });
    expect(metric('staff.drift_refused', 'unreliable_list')).toBe(4);
    listing = async () => [{ subject: 'idp-a', email: '', active: false, rawState: 'inactive' }];
    expect(await job([I]).run()).toMatchObject({ corrected: 1, refused: 0 }); // the positive inactive counts; b, c, d are absent and stay
    for (const x of ['b', 'c', 'd']) expect(await active(who(I, x))).toEqual([true]);
    expect(await active(who(I, 'a'))).toEqual([false]);
  });

  it('(4) a malformed entry switches absence off but a positive inactive still counts; a listed-active member with no email is never missing', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd', 'e']);
    listing = async () => [
      { subject: 'idp-a', email: '', active: true, rawState: 'active' }, // active, no email (the adapter's limitation): not missing
      { subject: 'idp-b', email: '', active: false, rawState: 'inactive' },
      { subject: 'idp-c', email: 'c@x', active: 'yes' }, // malformed
      null,
      { email: 'no-subject', active: true },
      { subject: 'idp-d', email: '', active: true, rawState: 'active' },
    ];
    expect(await job([I]).run()).toMatchObject({ corrected: 1 });
    expect(await active(who(I, 'a'))).toEqual([true]);
    expect(await active(who(I, 'b'))).toEqual([false]);
    expect(await active(who(I, 'c'))).toEqual([true]); // unparseable, absent from the valid entries: not removed
    expect(await active(who(I, 'e'))).toEqual([true]); // absent, but the list is not trusted
    expect(metric('staff.drift_refused', 'malformed_entry')).toBe(3);
  });

  it('(T-1116 / TST-AUTH-008 4) an unrecognised or missing raw state is suspect: counted, never a removal, absence switched off; a positive inactive still counts', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd', 'e', 'f']);
    now = new Date(NOW.getTime() + 25 * 3_600_000); // past the new-link grace: an absent link is a real doubt
    listing = async () => [
      { subject: 'idp-a', email: '', active: true, rawState: 'active' },
      { subject: 'idp-b', email: '', active: false, rawState: 'inactive' }, // positive: removed
      { subject: 'idp-c', email: '', active: false, rawState: 'suspended' }, // a new vendor value
      { subject: 'idp-d', email: '', active: false }, // no state at all
      { subject: 'idp-e', email: '', active: true, rawState: 'inactive' }, // at odds with `active`
    ];
    expect(await job([I]).run()).toMatchObject({ corrected: 1, failed: 0 });
    expect(await active(who(I, 'b'))).toEqual([false]);
    for (const x of ['a', 'c', 'd', 'e', 'f']) expect(await active(who(I, x))).toEqual([true]); // f is absent but the list is not trusted
    expect(metric('staff.drift_refused', 'unrecognised_state')).toBe(3);
    expect(metric('staff.drift_refused', 'unreliable_list')).toBe(1); // only f, the absent one: the suspect subjects are not double-counted as absent
    expect(metric('staff.drift_corrected', 'inactive')).toBe(1);
    expect(metric('staff.drift_corrected', 'missing')).toBe(0);
    // every reason the sweep emits is in the closed set
    const reasons = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => 'staff.drift_refused' in m).map((m) => m['reason'] as string);
    for (const r of reasons) expect(DRIFT_REFUSAL_REASONS as readonly string[]).toContain(r);
    expect(DRIFT_REFUSAL_REASONS).toContain('unrecognised_state');
  });

  it('(T-1116) with every state recognised, absence counts again (the suspect switch is per read, not sticky)', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    now = new Date(NOW.getTime() + 25 * 3_600_000);
    listing = async () => [{ subject: 'idp-a', email: '', active: true, rawState: 'active' }, { subject: 'idp-b', email: '', active: true, rawState: 'active' }, { subject: 'idp-c', email: '', active: true, rawState: 'active' }];
    expect(await job([I]).run()).toMatchObject({ corrected: 1 });
    expect(await active(who(I, 'd'))).toEqual([false]);
  });

  it('(4) a subject listed twice counts as active if either entry is; an empty subject is malformed; a non-list answer is a failed read', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    listing = async () => [{ subject: 'idp-a', email: '', active: true, rawState: 'active' }, { subject: 'idp-a', email: '', active: false, rawState: 'inactive' }, { subject: 'idp-b', email: '', active: true, rawState: 'active' }, { subject: 'idp-c', email: '', active: true, rawState: 'active' }];
    expect(await job([I]).run()).toMatchObject({ corrected: 1 }); // only d, absent
    expect(await active(who(I, 'a'))).toEqual([true]);
    expect(await active(who(I, 'd'))).toEqual([false]);
    const J = await institution(['a', 'b', 'c', 'd']);
    listing = async () => [{ subject: 'idp-a', email: '', active: true, rawState: 'active' }, { subject: '', email: '', active: true, rawState: 'active' }];
    expect(await job([J]).run()).toMatchObject({ corrected: 0 }); // the empty subject is malformed, so absence is off
    expect(metric('staff.drift_refused', 'malformed_entry')).toBe(1);
    listing = async () => null;
    await expect(job([J]).run()).rejects.toBeInstanceOf(DriftCycleFailed);
    expect(metric('staff.drift_refused', 'provider_unavailable')).toBe(1);
    await expect(job([J]).report()).rejects.toBeInstanceOf(DriftCycleFailed);
  });

  it('a removal that finds its link already gone is not counted as corrected', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    const dp = { remove: async () => false, finish: async () => undefined, institutions: () => [I] };
    expect(await job([I], { deprovision: dp }).run()).toMatchObject({ corrected: 0, failed: 0 });
    expect(metric('staff.drift_corrected')).toBe(0);
  });

  it('(S1) a link younger than 24 hours is not removed for absence, but a positive inactive is never graced', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const f = await staffer(who(I, 'f'), I);
    const g = await staffer(who(I, 'g'), I);
    await links.link(I, 'idp-f', f, SYSTEM, NOW);
    await links.link(I, 'idp-g', g, SYSTEM, NOW);
    await dir(I, 'g', false); // f is not listed yet
    expect(await job([I]).run()).toMatchObject({ corrected: 1 });
    expect(await active(who(I, 'f'))).toEqual([true]);
    expect(await active(who(I, 'g'))).toEqual([false]);
    now = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(await job([I]).run()).toMatchObject({ corrected: 1 }); // a day on, absence counts
    expect(await active(who(I, 'f'))).toEqual([false]);
  });

  it('(S2) a link ended and made again during the list call is not removed: the expected link id is part of the removal', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    listing = async (org) => {
      const answer = await sim.listDirectory(org);
      await links.unlink(I, 'idp-a', SYSTEM, NOW);
      await links.link(I, 'idp-a', people[who(I, 'a')]!.partyId, SYSTEM, NOW);
      return answer.map((e) => (e.subject === 'idp-a' ? { ...e, active: false, rawState: 'inactive' as const } : e));
    };
    expect(await job([I]).run()).toMatchObject({ corrected: 0, failed: 0 });
    expect(await active(who(I, 'a'))).toEqual([true]);
    expect(await links.find(I, 'idp-a')).toBe(people[who(I, 'a')]!.partyId);
    expect(await live(who(I, 'a'))).toBe(true);
  });

  it('(B2) a removal whose session step failed is finished however late (+61 min, +25 h) and then never again: a newer session survives', async () => {
    for (const lateMs of [61 * 60_000, 25 * 3_600_000]) {
      reset();
      const I = await institution(['a', 'b', 'c', 'd']);
      await dir(I, 'a', false);
      const a = people[who(I, 'a')]!.partyId;
      let boom = true;
      const dp = deprovisioner([I], { tokens: { revokeAll: async (p, r) => { if (boom && p === a) { boom = false; throw new Error('simulated crash'); } return app.services.tokens.revokeAll(p, r); } } });
      await expect(job([I], { deprovision: dp }).run()).rejects.toBeInstanceOf(DriftCycleFailed);
      expect(await live(who(I, 'a'))).toBe(true); // the staff row is gone but the session was not revoked: a 403, not a 401
      now = new Date(NOW.getTime() + lateMs);
      expect(await job([I]).run()).toMatchObject({ failed: 0 });
      expect(await live(who(I, 'a'))).toBe(false);
      expect(await roles(who(I, 'a'))).not.toContain('org_staff');
      // finished once: the person, still a Kesher member, signs in again; later cycles leave that session alone
      people['again'] = { partyId: a, access: (await app.services.tokens.issue({ partyId: a, deviceId: 'phone-2', roles: ['member'] })).accessToken };
      expect((await mine('again')).status).not.toBe(401);
      for (let i = 0; i < 3; i += 1) await job([I]).run();
      expect((await mine('again')).status).not.toBe(401);
    }
  });

  it('(S4) the flag is re-read before each institution and each removal; off mid-cycle stops further removals and still reports an earlier failure', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    flagState.budget = 2; // the start and the institution pass; the removal's check answers off
    expect(await job([I]).run()).toMatchObject({ skipped: 'flag_off', corrected: 0 });
    expect(await active(who(I, 'a'))).toEqual([true]);
    const X = await institution(['a', 'b', 'c']);
    const Y = await institution(['a', 'b', 'c', 'd']);
    await dir(Y, 'a', false);
    listing = async (org) => {
      if (org === X) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'down');
      return sim.listDirectory(org);
    };
    flagState.budget = 2; // the start and X; Y's institution pass answers off
    await expect(job([X, Y]).run()).rejects.toBeInstanceOf(DriftCycleFailed);
    expect(await active(who(Y, 'a'))).toEqual([true]);
  });

  it('a finished-late removal of the last admin sends the alert once', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await db.query("update org.staff set role = 'admin' where party_id = $1", [people[who(I, 'a')]!.partyId]);
    await dir(I, 'a', false);
    const sent: string[] = [];
    const spy: NotifyPort = { ...notify, send: async (m, key) => { sent.push(key); return notify.send(m, key); } } as NotifyPort;
    const a = people[who(I, 'a')]!.partyId;
    let boom = true;
    const dp = deprovisioner([I], { alertTo: 'ops@kesher.example', notify: spy, tokens: { revokeAll: async (p, r) => { if (boom && p === a) { boom = false; throw new Error('simulated crash'); } return app.services.tokens.revokeAll(p, r); } } });
    await expect(job([I], { deprovision: dp }).run()).rejects.toBeInstanceOf(DriftCycleFailed);
    expect(sent).toHaveLength(0);
    await job([I], { deprovision: dp }).run();
    await job([I], { deprovision: dp }).run();
    expect(sent.filter((k) => k.endsWith(':admin-none'))).toHaveLength(1);
  });

  it('two removals of the same key both answer true; the second only finds the first', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const dp = deprovisioner([I]);
    const how = { reason: 'Directory drift sweep', payload: { source: 'drift', drift_missing: false } };
    const [x, y] = await Promise.all([dp.remove(I, 'idp-a', 'drift:race', NOW, how), dp.remove(I, 'idp-a', 'drift:race', NOW, how)]);
    expect([x, y]).toEqual([true, true]);
    expect(await dp.remove(I, 'idp-b', 'drift:other', NOW, how)).toBe(true);
    expect(await dp.remove(I, 'idp-b', 'drift:another', NOW, how)).toBe(false); // no live link any more
  });

  it('(4) more than half of the linked staff in one cycle is refused: audit row once a day and a metric, nothing removed', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    await dir(I, 'b', false);
    await dir(I, 'c', false);
    expect(await job([I]).run()).toMatchObject({ corrected: 0, refused: 1 });
    for (const x of ['a', 'b', 'c', 'd']) expect(await active(who(I, x))).toEqual([true]);
    expect(metric('staff.drift_refused', 'guard_half')).toBe(1);
    const rows = async () => (await auditRows('institution.staff.drift_refused')).filter((r) => r.subject === I);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.payload).toMatchObject({ linked: 4, candidates: 3, reason: 'guard_half' });
    await job([I]).run();
    expect(await rows()).toHaveLength(1); // the same day: not another row every cycle
    now = new Date(NOW.getTime() + 86_400_000);
    await job([I]).run();
    expect(await rows()).toHaveLength(2);
  });

  it('(4) exactly half passes the guard', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    await dir(I, 'b', false);
    expect(await job([I]).run()).toMatchObject({ corrected: 2, refused: 0 });
  });

  it('(5) flag off does nothing and reads nothing; a flag service that throws fails closed; no binding does nothing', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    flagState.on = false;
    let revokes = 0;
    const spy = deprovisioner([I], { tokens: { revokeAll: async () => { revokes += 1; return 0; } } });
    expect(await job([I], { deprovision: spy }).run()).toMatchObject({ skipped: 'flag_off' });
    expect(revokes).toBe(0); // not even the finishing of earlier removals runs while the flag is off
    expect(await job([I]).run()).toMatchObject({ skipped: 'flag_off', corrected: 0 });
    expect(await job([I]).report()).toMatchObject({ skipped: 'flag_off' });
    expect(calls).toHaveLength(0);
    flagState.on = true;
    flagState.throws = true;
    await expect(job([I]).run()).rejects.toThrow('flag service down');
    expect(calls).toHaveLength(0);
    flagState.throws = false;
    expect(await job([I], { port: () => undefined }).run()).toMatchObject({ skipped: 'no_binding' });
    expect(await job([I], { deprovision: undefined }).run()).toMatchObject({ skipped: 'no_binding' });
    expect(await active(who(I, 'a'))).toEqual([true]);
    expect(calls).toHaveLength(0);
  });

  it('(a) a stale link at A never touches the party now active at B, nor their role or sessions', async () => {
    reset();
    const A = await institution(['a', 'b', 'c', 'd']);
    const B = await institution(['x']);
    const moved = who(A, 'a');
    await db.query('update org.staff set institution_id = $2 where party_id = $1', [people[moved]!.partyId, B]);
    await dir(A, 'a', false);
    expect(await job([A]).run()).toMatchObject({ failed: 0 });
    expect(await active(moved)).toEqual([true]);
    expect(await roles(moved)).toContain('org_staff');
    expect((await mine(moved)).status).toBe(200);
    expect(await links.find(A, 'idp-a')).toBeUndefined();
  });

  it('(b) the same subject linked at B is untouched by A\'s directory; a directory two institutions claim is never swept', async () => {
    reset();
    const A = await institution(['a', 'b', 'c', 'd']);
    const B = await institution(['a', 'b', 'c', 'd']);
    await dir(A, 'a', false);
    await job([A]).run();
    expect(await active(who(A, 'a'))).toEqual([false]);
    expect(await active(who(B, 'a'))).toEqual([true]);
    expect(directoryInstitutions({ x: { directoryId: 'd1' }, y: { directoryId: 'd1' }, z: { directoryId: 'd2' }, w: {} })).toEqual(['z']);
  });

  it('(d) an adapter refusal or an unexpected error is counted by a closed reason and skipped; the rest of the institutions are swept', async () => {
    reset();
    const X = await institution(['a', 'b', 'c']);
    const Y = await institution(['a', 'b', 'c']);
    const Z = await institution(['a', 'b', 'c', 'd']);
    await dir(Z, 'a', false);
    listing = async (org) => {
      if (org === X) throw new OrgIdPError('UNKNOWN_ORG', 'nope');
      if (org === Y) throw new TypeError('boom');
      return sim.listDirectory(org);
    };
    await expect(job([X, Y, Z]).run()).rejects.toMatchObject({ code: 'DRIFT_CYCLE_FAILED', result: { failed: 2, corrected: 1 } });
    expect(metric('staff.drift_refused', 'unknown_org')).toBe(1);
    expect(metric('staff.drift_refused', 'error')).toBe(1);
    expect(await active(who(Z, 'a'))).toEqual([false]);
    expect((await db.query('select 1 from ops.inbound_event')).rowCount).toBe(0); // nothing is queued
  });

  it('(d) a removal whose sessions step fails is finished by the next cycle; one failure does not stop the others', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd', 'e', 'f']);
    await dir(I, 'a', false);
    await dir(I, 'b', false);
    let boom = true;
    const dp = deprovisioner([I], { tokens: { revokeAll: async (p, r) => { if (boom && [people[who(I, 'a')]!.partyId, people[who(I, 'b')]!.partyId].includes(p)) { boom = false; throw new Error('simulated crash'); } return app.services.tokens.revokeAll(p, r); } } });
    await expect(job([I], { deprovision: dp }).run()).rejects.toBeInstanceOf(DriftCycleFailed);
    expect(await active(who(I, 'a'))).toEqual([false]);
    expect(await active(who(I, 'b'))).toEqual([false]); // the second was still removed
    const statuses = [await live(who(I, 'a')), await live(who(I, 'b'))];
    expect(statuses.filter((x) => x)).toHaveLength(1); // the one whose revoke crashed still holds its token
    expect(metric('staff.drift_refused', 'removal_failed')).toBe(1);
    expect(await job([I], { deprovision: dp }).run()).toMatchObject({ failed: 0 });
    expect(await live(who(I, 'a'))).toBe(false);
    expect(await live(who(I, 'b'))).toBe(false);
    expect(await roles(who(I, 'a'))).not.toContain('org_staff');
    expect(await roles(who(I, 'b'))).not.toContain('org_staff');
  });

  it('(e) the unlink clock is never earlier than the link\'s', async () => {
    reset();
    const I = await institution([]);
    const later = new Date(NOW.getTime() + 3_600_000);
    for (const nm of ['a', 'b', 'c']) {
      const party = await staffer(who(I, nm), I);
      await links.link(I, `idp-${nm}`, party, SYSTEM, nm === 'a' ? later : NOW);
      await dir(I, nm, nm !== 'a');
    }
    expect(await job([I]).run()).toMatchObject({ corrected: 1, failed: 0 });
    const row = (await db.query<{ unlinked_at: Date; linked_at: Date }>('select unlinked_at, linked_at from org.staff_idp_link where party_id = $1', [people[who(I, 'a')]!.partyId])).rows[0]!;
    expect(row.unlinked_at.getTime()).toBe(later.getTime());
  });

  it('(h) one list call per institution with a live link per cycle; none for one with no link; the nightly report counts unlinked users', async () => {
    reset();
    const I = await institution(['a', 'b']);
    const J = await institution(['a']);
    const K = await institution([]);
    await dir(K, 'u1', true);
    await dir(K, 'u2', false);
    await dir(I, 'u3', true);
    await job([I, J, K]).run();
    expect(calls.sort()).toEqual([I, J].sort());
    calls.length = 0;
    expect(await job([I, J, K]).report()).toMatchObject({ institutions: 3, unlinked: 3, failed: 0 });
    expect(calls.sort()).toEqual([I, J, K].sort());
    expect(metric('staff.directory_unlinked')).toBe(3);
  });

  it('a webhook removal that already happened leaves nothing for the sweep; a stale subject in the directory does nothing', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    await dir(I, 'a', false);
    await deprovisioner([I]).remove(I, 'idp-a', 'evt-hook', NOW, { reason: 'Directory event evt-hook' });
    expect(await job([I]).run()).toMatchObject({ corrected: 0, failed: 0 });
    expect(await auditRows('institution.staff.deprovision').then((r) => r.filter((x) => x.payload['institutionId'] === I))).toHaveLength(1);
  });

  it('(F1a) permanently failing finishes never block a fresh one behind them; each is retried, then abandoned and shown, and then left alone', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const fakes = Array.from({ length: 12 }, () => uuidv7(NOW));
    for (const [i, party] of fakes.entries()) {
      await app.services.audit.record({ ...SYSTEM, action: 'institution.staff.deprovision', subject: party, reason: 'test', payload: { institutionId: I, eventId: `drift:fake-${i}`, source: 'drift', removed: true, adminNone: false } }, NOW);
    }
    await dir(I, 'a', false);
    const a = people[who(I, 'a')]!.partyId;
    let boom = true;
    let calls = 0;
    const perFake = new Map<string, number>();
    const dp = deprovisioner([I], { tokens: { revokeAll: async (p, r) => { calls += 1; perFake.set(p, (perFake.get(p) ?? 0) + 1); if (fakes.includes(p) || (boom && p === a)) { if (p === a) boom = false; throw new Error('simulated failure'); } return app.services.tokens.revokeAll(p, r); } } });
    const tune = { resume: { batch: 5, cap: 8, maxAttempts: 3 } };
    await expect(job([I], { deprovision: dp, ...tune }).run()).rejects.toBeInstanceOf(DriftCycleFailed); // a's own finish fails once; the cycle also tried 8 older rows
    const drift = job([I], { deprovision: dp, ...tune });
    expect(await live(who(I, 'a'))).toBe(true); // not yet finished
    const results: DriftResult[] = [];
    for (let i = 0; i < 6; i += 1) results.push(await drift.run().catch((e: unknown) => (e as DriftCycleFailed).result));
    expect(await live(who(I, 'a'))).toBe(false); // finished behind the 12 failing rows, within a cycle or two
    expect(results.reduce((n, r) => n + (r.abandoned ?? 0), 0)).toBe(12);
    expect(metric('staff.drift_finish_abandoned')).toBe(12);
    expect((await auditRows('institution.staff.drift_finish_abandoned')).filter((r) => fakes.includes(r.subject))).toHaveLength(12);
    for (const f of fakes) expect(perFake.get(f)).toBe(3); // abandoned after exactly maxAttempts failed attempts
    const before = calls;
    expect(await drift.run()).toMatchObject({ failed: 0 }); // abandoned rows are not retried
    expect(calls).toBe(before);
  });

  it('(F1b) a cycle makes at most `cap` attempts and the next one carries on after where it stopped, wrapping round', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const fakes = Array.from({ length: 4 }, () => uuidv7(NOW));
    for (const [i, party] of fakes.entries()) {
      await app.services.audit.record({ ...SYSTEM, action: 'institution.staff.deprovision', subject: party, reason: 'test', payload: { institutionId: I, eventId: `drift:cap-${i}`, source: 'drift', removed: true, adminNone: false } }, NOW);
    }
    const hit: string[] = [];
    const dp = deprovisioner([I], { tokens: { revokeAll: async (p) => { if (fakes.includes(p)) { hit.push(p); throw new Error('simulated failure'); } return 0; } } });
    const drift = job([I], { deprovision: dp, resume: { batch: 2, cap: 3, maxAttempts: 1000 } });
    const cycle = async () => { hit.length = 0; await drift.run().catch(() => undefined); return [...hit]; };
    const c1 = await cycle();
    expect(c1).toEqual(fakes.slice(0, 3));
    const c2 = await cycle();
    expect(c2).toEqual([fakes[3], fakes[0], fakes[1]]);
    // settle: abandon them so later tests are untouched
    await job([I], { deprovision: dp, resume: { batch: 2, cap: 10, maxAttempts: 1 } }).run().catch(() => undefined);
  });

  it('(F1c) a replay of a finished removal revokes nothing and leaves a newer session alone', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const a = people[who(I, 'a')]!.partyId;
    let revokes = 0;
    const dp = deprovisioner([I], { tokens: { revokeAll: async (p, r) => { revokes += 1; return app.services.tokens.revokeAll(p, r); } } });
    const how = { reason: 'Directory drift sweep', payload: { source: 'drift', drift_missing: false } };
    expect(await dp.remove(I, 'idp-a', 'drift:replay', NOW, how)).toBe(true);
    expect(revokes).toBe(1);
    people['replay'] = { partyId: a, access: (await app.services.tokens.issue({ partyId: a, deviceId: 'phone-3', roles: ['member'] })).accessToken };
    expect(await dp.remove(I, 'idp-a', 'drift:replay', NOW, how)).toBe(true);
    expect(revokes).toBe(1);
    expect((await mine('replay')).status).not.toBe(401);
  });

  it('(F1d) markers are keyed by institution and the hash of the event id: the same event at another institution is its own, a very long id works', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const J = await institution(['x', 'y', 'z', 'w']);
    const a = people[who(I, 'a')]!.partyId;
    let revokes = 0;
    const dp = deprovisioner([I, J], { tokens: { revokeAll: async (p, r) => { revokes += 1; return app.services.tokens.revokeAll(p, r); } } });
    const how = { reason: 'Directory drift sweep', payload: { source: 'drift', drift_missing: false } };
    const long = 'e'.repeat(5000);
    expect(await dp.remove(I, 'idp-a', long, NOW, how)).toBe(true);
    const kinds = async (party: string) => (await db.query<{ kind: string }>('select kind from ops.workflow_marker where subject_id = $1', [party])).rows.map((r) => r.kind);
    expect(await kinds(a)).toEqual([`deprovision_finished:${removalKey(I, long)}`]);
    expect(removalKey(I, long).length).toBeLessThan(120);
    // the same party is hired at J and removed there under the SAME event id: a separate removal, finished separately
    await db.query('update org.staff set institution_id = $2, active = true where party_id = $1', [a, J]);
    await links.link(J, 'idp-a-at-j', a, SYSTEM, OLD);
    expect(await dp.remove(J, 'idp-a-at-j', long, NOW, how)).toBe(true);
    expect(revokes).toBe(2);
    expect((await kinds(a)).sort()).toEqual([`deprovision_finished:${removalKey(I, long)}`, `deprovision_finished:${removalKey(J, long)}`].sort());
    expect(removalKey(I, long)).not.toBe(removalKey(J, long));
  });
});

describe('mutation gaps the reviewers proved survive (TST-AUTH-008, T-1124: D24, m44, m46, C3, C4)', () => {
  const entry = (name: string, isActive: boolean, rawState: unknown) => ({ subject: `idp-${name}`, email: '', active: isActive, rawState });

  it('D24: the unlinked count is the directory users WITHOUT a live link, in the nightly report and in the sweep, with more linked users than unlinked ones (an inverted filter counts the linked)', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd', 'e']);
    listing = async () => [...['a', 'b', 'c', 'd', 'e'].map((x) => entry(x, true, 'active')), entry('ghost1', true, 'active'), entry('ghost2', false, 'inactive'), entry('ghost3', false, 'suspended')];
    expect(await job([I]).report()).toMatchObject({ institutions: 1, unlinked: 3, failed: 0 });
    expect(metric('staff.directory_unlinked')).toBe(3);
    lines.length = 0;
    expect(await job([I]).run()).toMatchObject({ unlinked: 3, corrected: 0, failed: 0 });
    // nobody linked is unlinked: a directory of exactly the linked users counts zero
    listing = async () => ['a', 'b', 'c', 'd', 'e'].map((x) => entry(x, true, 'active'));
    expect(await job([I]).report()).toMatchObject({ unlinked: 0 });
    expect(await job([I]).run()).toMatchObject({ unlinked: 0 });
    // a user whose link ended is unlinked again (the count is about LIVE links)
    await links.unlink(I, 'idp-e', SYSTEM, NOW);
    expect(await job([I]).report()).toMatchObject({ unlinked: 1 });
  });

  it('m44: an entry whose rawState is `active` but whose `active` is false is SUSPECT: counted, never a removal, and absence is switched off for the read', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    now = new Date(NOW.getTime() + 25 * 3_600_000);
    listing = async () => [entry('a', false, 'active'), entry('b', true, 'active'), entry('c', true, 'active'), entry('d', true, 'active')];
    expect(await job([I]).run()).toMatchObject({ corrected: 0, refused: 0, failed: 0 });
    expect(await active(who(I, 'a'))).toEqual([true]);
    expect(metric('staff.drift_refused', 'unrecognised_state')).toBe(1);
    // the mirror image is the positive inactive that does count: `inactive` with `active` false
    listing = async () => [entry('a', false, 'inactive'), entry('b', true, 'active'), entry('c', true, 'active'), entry('d', true, 'active')];
    expect(await job([I]).run()).toMatchObject({ corrected: 1 });
    expect(await active(who(I, 'a'))).toEqual([false]);
  });

  it('m46: ONE suspect entry is enough to switch absence off (a linked member who is not listed stays), and so is ONE malformed entry', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd', 'e']);
    now = new Date(NOW.getTime() + 25 * 3_600_000); // past the new-link grace: e is genuinely absent
    const base = ['a', 'b', 'c', 'd'].map((x) => entry(x, true, 'active'));
    listing = async () => [...base.slice(0, 3), entry('d', false, 'suspended')];
    expect(await job([I]).run()).toMatchObject({ corrected: 0, failed: 0 });
    expect(await active(who(I, 'e'))).toEqual([true]);
    expect(metric('staff.drift_refused', 'unrecognised_state')).toBe(1);
    expect(metric('staff.drift_refused', 'unreliable_list')).toBe(1);
    lines.length = 0;
    listing = async () => [...base, null];
    expect(await job([I]).run()).toMatchObject({ corrected: 0, failed: 0 });
    expect(await active(who(I, 'e'))).toEqual([true]);
    expect(metric('staff.drift_refused', 'malformed_entry')).toBe(1);
    expect(metric('staff.drift_refused', 'unreliable_list')).toBe(1);
    // with the list clean again the same absent member goes (so the two refusals above were the single bad entry and nothing else)
    listing = async () => base;
    expect(await job([I]).run()).toMatchObject({ corrected: 1 });
    expect(await active(who(I, 'e'))).toEqual([false]);
  });

  it('a subject listed twice with one suspect entry is never removed, in either order (the duplicate at the sweep: pinned as it is today)', async () => {
    reset();
    for (const order of ['suspended-then-inactive', 'inactive-then-suspended'] as const) {
      const I = await institution(['a', 'b', 'c', 'd']);
      const dup = order === 'suspended-then-inactive' ? [entry('a', false, 'suspended'), entry('a', false, 'inactive')] : [entry('a', false, 'inactive'), entry('a', false, 'suspended')];
      listing = async () => [...dup, entry('b', true, 'active'), entry('c', true, 'active'), entry('d', true, 'active')];
      expect(await job([I]).run(), order).toMatchObject({ corrected: 0, failed: 0 });
      expect(await active(who(I, 'a')), order).toEqual([true]);
    }
  });

  it('C4: a failing finish is abandoned after exactly 20 failed attempts by default: the 19th leaves it retrying, the 20th abandons it, the 21st cycle does not try again', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const fake = uuidv7(NOW);
    await app.services.audit.record({ ...SYSTEM, action: 'institution.staff.deprovision', subject: fake, reason: 'test', payload: { institutionId: I, eventId: 'drift:c4-fake', source: 'drift', removed: true, adminNone: false } }, NOW);
    let attempts = 0;
    const dp = deprovisioner([I], { tokens: { revokeAll: async (p, r) => { if (p === fake) { attempts += 1; throw new Error('simulated failure'); } return app.services.tokens.revokeAll(p, r); } } });
    const drift = job([I], { deprovision: dp }); // default resume settings: nothing injected
    const abandoned = async () => (await auditRows('institution.staff.drift_finish_abandoned')).filter((r) => r.subject === fake).length;
    const results: DriftResult[] = [];
    for (let i = 1; i <= 19; i += 1) results.push(await drift.run().catch((e: unknown) => (e as DriftCycleFailed).result));
    expect(attempts).toBe(19);
    expect(await abandoned()).toBe(0);
    expect(results.reduce((n, r) => n + (r.abandoned ?? 0), 0)).toBe(0);
    results.push(await drift.run().catch((e: unknown) => (e as DriftCycleFailed).result));
    expect(attempts).toBe(20);
    expect(await abandoned()).toBe(1);
    expect(results.at(-1)).toMatchObject({ abandoned: 1 });
    expect(metric('staff.drift_finish_abandoned')).toBe(1);
    expect(await drift.run()).toMatchObject({ failed: 0 });
    expect(attempts).toBe(20);
  });

  it('C3: one cycle makes at most 500 resume attempts by default: with 501 failing finishes waiting, the 501st is left for the next cycle', async () => {
    reset();
    const I = await institution(['a', 'b', 'c', 'd']);
    const fakes: string[] = [];
    for (let i = 0; i < 501; i += 1) {
      const party = uuidv7(NOW);
      fakes.push(party);
      await app.services.audit.record({ ...SYSTEM, action: 'institution.staff.deprovision', subject: party, reason: 'test', payload: { institutionId: I, eventId: `drift:c3-${i}`, source: 'drift', removed: true, adminNone: false } }, NOW);
    }
    const hit: string[] = [];
    const set = new Set(fakes);
    const dp = deprovisioner([I], { tokens: { revokeAll: async (p, r) => { if (set.has(p)) { hit.push(p); throw new Error('simulated failure'); } return app.services.tokens.revokeAll(p, r); } } });
    await expect(job([I], { deprovision: dp }).run()).rejects.toBeInstanceOf(DriftCycleFailed); // default resume settings: nothing injected
    expect(hit).toHaveLength(500);
    expect(hit).toEqual(fakes.slice(0, 500));
    expect(hit).not.toContain(fakes[500]);
    // settle: abandon them all so the cycles of later tests are untouched
    for (const [i, party] of fakes.entries()) await putMarker(db, { kind: `deprovision_abandoned:${removalKey(I, `drift:c3-${i}`)}`, subjectId: party, value: 'abandoned' });
    expect(await job([I]).run()).toMatchObject({ failed: 0 });
  }, 180_000);
});

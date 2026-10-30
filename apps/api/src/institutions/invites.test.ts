// TST-INS-002: each family on a roster receives an invite, and the console shows the funnel
// invited → verified → active. Given 120 invited, the counts add up to 120.
// Activation rows (T-0626): the student accepts from the link signed in; a T1 member is active at once, one
// without KYC is verified until the approval lands; an expired, used or unknown link answers 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { NotifySimulator, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { createApp, type App } from '../app.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { InviteService } from './invites.ts';
import { RosterService } from './roster.ts';

let db: TestDatabase;
let roster: RosterService;
let invites: InviteService;
let notify: NotifySimulator;
let institutionId: string;
const approved = new Set<string>();
/** The token an invite link carries, as the member app reads it. */
const tokenOf = (link: string | undefined): string => new URL(link ?? '').searchParams.get('token') ?? '';
const now = new Date('2026-11-01T10:00:00Z');
const mapping = { memberName: 'Student', memberPhone: 'Student mobile', funderEmail: 'Parent email', funderPhone: 'Parent mobile' };

function csv(rows: number): string {
  const lines = ['Student,Student mobile,Parent email,Parent mobile'];
  for (let i = 1; i <= rows; i++) lines.push(`Student ${i},+9725${String(i).padStart(8, '0')},parent${i}@example.com,${i % 10 === 0 ? '' : `+1555${String(i).padStart(7, '0')}`}`);
  return lines.join('\n');
}

beforeAll(async () => {
  db = await createTestDatabase();
  roster = new RosterService(db);
  notify = new NotifySimulator();
  // The service-level rows decide identity by a set; the HTTP rows below go through KYC itself.
  invites = new InviteService(db, notify, { isApproved: async (partyId) => approved.has(partyId) });
  institutionId = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [institutionId]);
}, 60_000);
afterAll(async () => db.close());

describe('InviteService (REQ-INS-002)', () => {
  it('fans out one invite per family after a committed import, idempotently, and the funnel sums to the roster size', async () => {
    const imp = await roster.import({ idempotencyKey: 'imp-1', institutionId, csv: csv(120), mapping, commit: true, createdBy: uuidv7() }, now);
    const a = await invites.fanOut(imp.importId, now);
    const b = await invites.fanOut(imp.importId, now);
    expect(a.sent).toBe(120);
    expect(b.sent).toBe(0);
    expect(notify.sent.filter((n) => n.template === 'institution.invite').length).toBe(120);
    const funnel = await invites.funnel(institutionId);
    expect(funnel).toEqual({ invited: 120, verified: 0, active: 0, declined: 0, total: 120 });
    expect(funnel.invited + funnel.verified + funnel.active + funnel.declined).toBe(120);
  });

  it('invites go by email to the funder and carry an opaque token; the address never lands in the row', async () => {
    const [first] = notify.sent;
    expect(first).toMatchObject({ channel: 'email', to: 'parent1@example.com', category: 'service', data: expect.objectContaining({ inviteUrl: expect.stringMatching(/^https:\/\/app\.kesher\.example\/invite\?token=[A-Za-z0-9_-]{20,}$/) }) });
    const row = await db.query<{ recipient_hash: string; token_hash: string }>('select recipient_hash, token_hash from org.invite limit 1');
    expect(row.rows[0]!.recipient_hash).not.toContain('@');
    expect(JSON.stringify(row.rows)).not.toContain('parent1');
  });

  it('accepting an invite moves the family to verified, the identity approval to active, and the funnel stays a partition', async () => {
    const url = tokenOf(notify.sent[0]!.data['inviteUrl']);
    const party = uuidv7();
    const accepted = await invites.accept(url, { memberPartyId: party }, now);
    expect(accepted.status).toBe('verified');
    expect(await invites.accept(url, { memberPartyId: party }, now)).toEqual(accepted);
    await expect(invites.accept(url, { memberPartyId: uuidv7() }, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    approved.add(party);
    expect(await invites.onIdentityApproved(party, now)).toBe(1);
    expect(await invites.onIdentityApproved(party, now)).toBe(0);
    const funnel = await invites.funnel(institutionId);
    expect(funnel).toEqual({ invited: 119, verified: 0, active: 1, declined: 0, total: 120 });
  });

  it('expired or unknown tokens are refused and a reminder re-sends to still-invited families only', async () => {
    await expect(invites.accept('nope', { memberPartyId: uuidv7() }, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const url = tokenOf(notify.sent[1]!.data['inviteUrl']);
    await expect(invites.accept(url, { memberPartyId: uuidv7() }, new Date(now.getTime() + 31 * 86_400_000))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const before = notify.sent.length;
    const r = await invites.remind(institutionId, new Date(now.getTime() + 3 * 86_400_000));
    expect(r.sent).toBe(119);
    expect(notify.sent.length - before).toBe(119);
    expect(notify.sent.slice(before).every((n) => n.template === 'institution.invite_reminder')).toBe(true);
  });
});

describe('the invite link over HTTP (T-0626)', () => {
  let app: App;
  let clock: AdvanceableClock;
  let yeshiva: string;
  let sim: SimulatorHost;
  const tokens: string[] = [];

  const call = (method: 'GET' | 'POST', url: string, bearer?: string, key?: string) =>
    dispatch(app, { method, url: `/v1${url}`, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, rawBody: '', now: clock.now() });
  const member = async (): Promise<{ partyId: string; token: string }> => {
    const partyId = uuidv7();
    return { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  };
  const passKyc = async (partyId: string): Promise<void> => {
    const session = await app.services.kyc.start(partyId, 'T1', `kyc-${partyId}`, clock.now());
    const hook = await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-kyc-${partyId}`, sessionId: session.sessionId, status: 'approved' }), now: clock.now() });
    expect(hook.status).toBeLessThan(300);
  };
  const statusOf = async (memberId: string) => (await db.query<{ status: string }>('select status from org.member where id = $1', [memberId])).rows[0]!.status;

  beforeAll(async () => {
    clock = fixedClock('2026-11-02T09:00:00Z') as AdvanceableClock;
    sim = new SimulatorHost();
    app = createApp({ db, registry: sim.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => clock.now() });
    yeshiva = uuidv7();
    const finance = uuidv7();
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat HTTP', 'IL')`, [yeshiva]);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'finance')`, [finance, yeshiva]);
    const staff = (await app.services.tokens.issue({ partyId: finance, deviceId: 'web', roles: ['org_finance'] })).accessToken;
    const body = JSON.stringify({ csv: ['Student,Parent email,Programme', 'Avi Example,a@example.test,Shiur Alef', 'Eli Example,e@example.test,Shiur Bet', 'Gil Example,g@example.test,'].join('\n'), mapping: { memberName: 'Student', funderEmail: 'Parent email', programme: 'Programme' }, commit: true });
    const imported = await dispatch(app, { method: 'POST', url: `/v1/institutions/${yeshiva}/rosters`, headers: { 'content-type': 'application/json', authorization: `Bearer ${staff}`, 'idempotency-key': 'http-roster-1' }, rawBody: body, now: clock.now() });
    expect(imported.body).toMatchObject({ status: 'committed', rowCount: 3 });
    // The committed import fanned out (T-0626): one invite per row, carrying the link.
    for (const to of ['a@example.test', 'e@example.test', 'g@example.test']) tokens.push(tokenOf(sim.simulators.notify.sent.find((n) => n.to === to)!.data['inviteUrl']));
  }, 60_000);

  it('previews the invite without a sign-in: institution, roster name, programme, open', async () => {
    const r = await call('GET', `/invites/${tokens[0]}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ institutionName: 'Yeshivat HTTP', memberName: 'Avi Example', programme: 'Shiur Alef', status: 'open' });
    expect((await call('GET', `/invites/${tokens[2]}`)).body).not.toHaveProperty('programme');
  });

  it('a T1 member who accepts is active at once, and a retry by them answers the same', async () => {
    const avi = await member();
    await passKyc(avi.partyId);
    const r = await call('POST', `/invites/${tokens[0]}/accept`, avi.token, 'accept-avi-1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'active' });
    expect(await statusOf((r.body as { memberId: string }).memberId)).toBe('active');
    expect((await call('POST', `/invites/${tokens[0]}/accept`, avi.token, 'accept-avi-2')).body).toEqual(r.body);
    expect((await call('GET', `/invites/${tokens[0]}`)).body).toMatchObject({ status: 'accepted' });
    // One roster row per member per institution.
    expect((await call('POST', `/invites/${tokens[2]}/accept`, avi.token, 'accept-avi-3')).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('a member without KYC is verified until their T1 approval lands, then active', async () => {
    const eli = await member();
    const r = await call('POST', `/invites/${tokens[1]}/accept`, eli.token, 'accept-eli-1');
    expect(r.body).toMatchObject({ status: 'verified' });
    const memberId = (r.body as { memberId: string }).memberId;
    expect(await statusOf(memberId)).toBe('verified');
    await passKyc(eli.partyId);
    expect(await statusOf(memberId)).toBe('active');
  });

  it('an expired, used or unknown token answers 404; accept needs a member and an idempotency key', async () => {
    const someone = await member();
    expect((await call('POST', `/invites/${tokens[0]}/accept`, someone.token, 'accept-used-1')).status).toBe(404);
    expect((await call('GET', '/invites/AAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await call('POST', '/invites/AAAAAAAAAAAAAAAAAAAAAAAA/accept', someone.token, 'accept-unknown-1')).status).toBe(404);
    expect((await call('POST', `/invites/${tokens[2]}/accept`)).status).toBe(401);
    expect((await call('POST', `/invites/${tokens[2]}/accept`, someone.token)).status).toBe(422);
    clock.advance(31 * 86_400_000);
    expect((await call('GET', `/invites/${tokens[2]}`)).body).toMatchObject({ status: 'expired' });
    // The bearer outlived its 15 minutes with the clock; a fresh one sees the same expired link.
    const later = await member();
    expect((await call('POST', `/invites/${tokens[2]}/accept`, later.token, 'accept-late-1')).status).toBe(404);
  });

  it('the funnel counts still add up', async () => {
    expect(await app.services.invites.funnel(yeshiva)).toEqual({ invited: 1, verified: 0, active: 2, declined: 0, total: 3 });
  });
});

// T-1104 invite someone to receive (REQ-PAY-001, enabling; phase 1 gap 4b). The sender explicitly invites a phone that
// is not a member; the lookup and the send keep answering the same 404 for it. The invite records who, a keyed hash
// of the phone, an optional amount hint and a category from a closed set, expires in 14 days and sends exactly one
// text. It never creates a journal, a hold or a transfer. When the invitee joins and passes T1 the invite becomes
// claimable and the sender is told; the sender then takes the recipient to the ordinary send (limits, new-pair hold
// and idempotency unchanged). An invite to a number that already belongs to a verified member answers the same way
// and later becomes claimable; an expired invite cannot be claimed; the same sender inviting the same number twice
// finds the open invite. The phone is never in a log, a response or a plain column.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { NotifyError, type NotifySimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import { INVITE_CATEGORIES, INVITE_TTL_MS, INVITES_PER_DAY, RECONCILE_EVERY_MS, RECONCILE_PER_CALL, type RecipientInviteView } from './recipient-invite.ts';

let db: TestDatabase;
let app: App;
let off: App;
let host: SimulatorHost;
let signingKey: Awaited<ReturnType<typeof generateSigningKey>>;
const T0 = new Date('2026-11-10T09:00:00Z');
let now = T0;
const DAY = 86_400_000;

const mk = (phone: string) => ({ id: uuidv7(T0), phone });
const SENDER = mk('+15555550201');
const OTHER = mk('+15555550202');
const NOT_T1 = mk('+15555550203');
const RATE = mk('+15555550204');
const S2 = mk('+15555550205');
const S2B = mk('+15555550206');
const S3 = mk('+15555550207');
const CAT = mk('+15555550208');
const S4 = mk('+15555550209');
const S5 = mk('+15555550210');
const S6 = mk('+15555550211');
const S7 = mk('+15555550212');
const HELD = mk('+15555550213');
const EXISTING = mk('+972501119999');

const sim = () => host.simulators.notify as NotifySimulator;
const bearer = async (who: { id: string }) => (await app.services.tokens.issue({ partyId: who.id, deviceId: `phone-${who.id.slice(-6)}`, roles: ['member'] })).accessToken;
const call = async (who: { id: string } | undefined, method: string, url: string, body?: unknown, a: App = app) =>
  dispatch(a, { method, url, headers: who ? { authorization: `Bearer ${await bearer(who)}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const invite = (who: { id: string }, body: unknown, a: App = app) => call(who, 'POST', '/v1/p2p/recipient-invites', body, a);
const list = async (who: { id: string }) => ((await call(who, 'GET', '/v1/p2p/recipient-invites')).body as { items: RecipientInviteView[] }).items;
const list0 = (who: { id: string }) => call(who, 'GET', '/v1/p2p/recipient-invites');
const claim = (who: { id: string }, id: string) => call(who, 'POST', `/v1/p2p/recipient-invites/${id}/claim`);
const problem = (r: { body?: unknown }) => { const { traceId: _t, ...rest } = r.body as Record<string, unknown>; return rest; };
const texts = (to: string, template?: string) => sim().sent.filter((n) => n.to === to && (template === undefined || n.template === template));
const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
const moneyRows = async () => `${await count('select count(*) as n from ledger.journal')}/${await count('select count(*) as n from ops.transfer')}`;

async function member(m: { id: string; phone: string }, t1 = true) {
  await app.services.identity.createUser({ partyId: m.id, phone: m.phone, status: 'active', roles: ['member'], createdAt: T0.toISOString() });
  if (t1) await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, 'T1', 'US', 'simulator', 'approved', $3, $3::timestamptz + interval '1 day', $3)`, [`kyc-${m.id}`, m.id, T0]);
}

/** The invitee signs up (an account) and the KYC provider approves T1, through the real webhook. */
async function join(m: { id: string; phone: string }, approve = true) {
  await app.services.identity.createUser({ partyId: m.id, phone: m.phone, status: 'active', roles: ['member'], createdAt: now.toISOString() });
  if (!approve) return;
  const session = await app.services.kyc.start(m.id, 'T1', `kyc-join-${m.id}`, now);
  const r = await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-${m.id}`, sessionId: session.sessionId, status: 'approved' }), now });
  expect(r.status).toBeLessThan(300);
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  signingKey = await generateSigningKey();
  const opts = { db, registry: host.registry, market: 'IL' as const, signingKey, issuer: 'https://api.kesher.example', clock: () => now };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'p2p.enabled': true, 'wallet.enabled': true, 'phase1.recipientInvite': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'p2p.enabled': true, 'phase1.recipientInvite': false }) });
  for (const m of [SENDER, OTHER, RATE, S2, S2B, S3, CAT, S4, S5, S6, S7, HELD, EXISTING]) await member(m);
  await member(NOT_T1, false);
  await app.services.displayNames.set(EXISTING.id, { firstName: 'Dana', lastName: 'Example' }, T0);
}, 60_000);
afterAll(async () => db.close());
afterEach(() => {
  now = T0;
  vi.restoreAllMocks();
});

describe('T-1104 inviting someone with no account', () => {
  it('records the invite and sends exactly one text; no journal, hold or transfer exists; the phone is nowhere in plain', async () => {
    const before = await moneyRows();
    const r = await invite(SENDER, { phone: '+972 50-111-0001', amountHint: { minor: '50000', currency: 'ILS' }, category: 'soldier' });
    expect(r.status).toBe(201);
    const v = r.body as RecipientInviteView;
    expect(v).toMatchObject({ status: 'open', amountHint: { minor: '50000', currency: 'ILS' }, category: 'soldier', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString() });
    expect(INVITE_TTL_MS).toBe(14 * DAY);
    expect(JSON.stringify(r.body)).not.toContain('1110001');
    expect(texts('+972501110001')).toHaveLength(1);
    expect(texts('+972501110001')[0]).toMatchObject({ channel: 'sms', template: 'p2p.invite' });
    expect(Object.values(texts('+972501110001')[0]!.data).join(' ')).not.toMatch(/soldier|500/); // the sender's words and hint never travel in the text
    expect(await moneyRows()).toBe(before);
    // Stored: the sender, a 32-byte keyed hash, a sealed copy; the row and its history say nothing in plain.
    const row = (await db.query<{ sender_party_id: string; idx: number; sealed: boolean; dump: string }>(`select sender_party_id, octet_length(phone_index) as idx, phone_sealed is not null as sealed, row_to_json(i)::text || coalesce((select string_agg(row_to_json(e)::text, '') from ops.recipient_invite_event e where e.invite_id = i.id), '') as dump from ops.recipient_invite i where id = $1`, [v.id])).rows[0]!;
    expect(row).toMatchObject({ sender_party_id: SENDER.id, idx: 32, sealed: true });
    expect(row.dump).not.toContain('1110001');
    expect(row.dump).not.toContain('+972');
  });

  it('the lookup and the send keep answering the same 404 for that number, invite or not', async () => {
    const unknown = await call(SENDER, 'POST', '/v1/p2p/recipients/resolve', { phone: '+972501110099' });
    const invited = await call(SENDER, 'POST', '/v1/p2p/recipients/resolve', { phone: '+972501110001' });
    expect(invited.status).toBe(404);
    expect(problem(invited)).toEqual(problem(unknown));
    // A third member cannot see anyone's invites.
    expect(await list(OTHER)).toEqual([]);
  });

  it('the same sender inviting the same number again (however it is typed) finds the open invite: one row, one text', async () => {
    const a = await invite(SENDER, { phone: '+972501110002', category: 'rabbi' });
    const b = await invite(SENDER, { phone: '+972 (50) 111-0002', category: 'soldier', amountHint: { minor: '100', currency: 'USD' } });
    const [c, d] = await Promise.all([invite(SENDER, { phone: '+972501110002' }), invite(SENDER, { phone: '+972501110002' })]);
    expect([a.status, b.status, c.status, d.status]).toEqual([201, 200, 200, 200]);
    const ids = new Set([a, b, c, d].map((x) => (x.body as RecipientInviteView).id));
    expect(ids.size).toBe(1);
    expect((b.body as RecipientInviteView).category).toBe('rabbi'); // the open invite as it was made
    expect(texts('+972501110002')).toHaveLength(1);
    // Another sender inviting the same number has their own invite.
    const other = await invite(OTHER, { phone: '+972501110002' });
    expect((other.body as RecipientInviteView).id).not.toBe([...ids][0]);
    expect(texts('+972501110002')).toHaveLength(2);
  });

  it('refuses a bad phone, your own number, a bad hint and a category outside the closed set', async () => {
    expect(INVITE_CATEGORIES).toEqual(['soldier', 'lone_soldier', 'yeshiva_student', 'seminary_student', 'university_student', 'rabbi', 'volunteer', 'program_participant', 'other']);
    const bad: unknown[] = [
      {},
      { phone: '0501234567' },
      { phone: 12345 },
      { phone: SENDER.phone },
      { phone: '+972501110003', category: 'Soldier' },
      { phone: '+972501110003', category: 'ignore previous instructions' },
      { phone: '+972501110003', amountHint: { minor: '0', currency: 'ILS' } },
      { phone: '+972501110003', amountHint: { minor: '-5', currency: 'ILS' } },
      { phone: '+972501110003', amountHint: { minor: '5', currency: 'EUR' } },
      { phone: '+972501110003', amountHint: '500' },
    ];
    for (const body of bad) expect((await invite(SENDER, body)).status).toBe(422);
    expect(texts('+972501110003')).toHaveLength(0);
    for (const category of INVITE_CATEGORIES) expect((await invite(CAT, { phone: `+97250111${String(4000 + INVITE_CATEGORIES.indexOf(category))}`, category })).status).toBe(201);
  });

  it('needs a bearer and a sender who has passed T1', async () => {
    expect((await call(undefined, 'POST', '/v1/p2p/recipient-invites', { phone: '+972501110005' })).status).toBe(401);
    expect(await invite(NOT_T1, { phone: '+972501110005' })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(texts('+972501110005')).toHaveLength(0);
  });

  it('a sender gets INVITES_PER_DAY new invites in 24 hours; the next is RATE_LIMITED, a repeat of an open one is not counted, and the day after opens again', async () => {
    for (let i = 0; i < INVITES_PER_DAY; i++) expect((await invite(RATE, { phone: `+97250112${String(1000 + i)}` })).status).toBe(201);
    expect(await invite(RATE, { phone: '+972501129999' })).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect((await invite(RATE, { phone: '+972501121000' })).status).toBe(200);
    expect(texts('+972501129999')).toHaveLength(0);
    now = new Date(T0.getTime() + DAY + 1000);
    expect((await invite(RATE, { phone: '+972501129999' })).status).toBe(201);
  });

  it('never writes the phone to a log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await invite(SENDER, { phone: '+972501110006', category: 'volunteer' });
    await invite(SENDER, { phone: '+972501110006' });
    await invite(SENDER, { phone: 'not a phone 972501110006' });
    await list(SENDER);
    await claim(SENDER, (r.body as RecipientInviteView).id);
    const logged = JSON.stringify([...spies.map((s) => s.mock.calls), out.mock.calls, err.mock.calls]);
    expect(logged).not.toContain('1110006');
  });
});

describe('T-1104 the invitee joins', () => {
  it('a new member with T1 makes the invite claimable once and tells the sender once; the sender takes them to the ordinary send, hold and idempotency unchanged', async () => {
    const dana = mk('+972501110010');
    const sender = S2;
    const told0 = texts(sender.phone, 'p2p.invite_claimable').length;
    const created = (await invite(sender, { phone: dana.phone, amountHint: { minor: '60000', currency: 'ILS' }, category: 'lone_soldier' })).body as RecipientInviteView;
    expect((await claim(sender, created.id)).status).toBe(409); // nobody has joined: nothing to claim
    await join(dana, false); // an account without T1 changes nothing
    expect((await list(sender)).find((i) => i.id === created.id)?.status).toBe('open');
    expect(texts(sender.phone, 'p2p.invite_claimable')).toHaveLength(told0);
    await join({ id: uuidv7(T0), phone: '+972501110011' }); // someone else's approval changes nothing
    const kyc = await app.services.kyc.start(dana.id, 'T1', `kyc-join-${dana.id}`, now);
    const hook = { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-${dana.id}`, sessionId: kyc.sessionId, status: 'approved' }), now };
    expect((await dispatch(app, hook)).status).toBeLessThan(300);
    await dispatch(app, hook); // a replayed event
    await app.services.recipientInvites.onIdentityApproved(dana.id, now); // and the hook run again
    expect((await list(sender)).find((i) => i.id === created.id)?.status).toBe('claimable');
    expect(texts(sender.phone, 'p2p.invite_claimable')).toHaveLength(told0 + 1);
    expect(await count(`select count(*) as n from ops.recipient_invite_event where invite_id = '${created.id}' and to_status = 'claimable'`)).toBe(1);

    const claimed = await claim(sender, created.id);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ invite: { id: created.id, status: 'claimed' }, recipient: { partyId: dana.id, canReceive: true } });
    expect(JSON.stringify(claimed.body)).not.toContain('1110010');
    expect((await claim(sender, created.id)).body).toEqual(claimed.body); // a retry after a lost response
    expect((await claim(OTHER, created.id)).status).toBe(404); // not theirs

    // The ordinary send: ₪600 to a new counterparty is over the new-pair threshold, so it is held; the same key is the same transfer.
    await runLoad(app.services.loads, { payerPartyId: sender.id, memberPartyId: sender.id, method: 'card', amount: money(500_000n, 'ILS'), paymentMethodId: 'pm_ok' }, `fund-${sender.id}`, now);
    const body = { toPartyId: dana.id, amount: { minor: '60000', currency: 'ILS' } };
    const sent = await app.services.p2p.send(sender.id, body, 'send-invite-0001', now);
    expect(sent.state).toBe('pending_hold');
    expect((await app.services.p2p.send(sender.id, body, 'send-invite-0001', now)).id).toBe(sent.id);
  });

  it('an invite to a number that already belongs to a verified member looks the same to the sender, is texted like any other, and becomes claimable when the sender next looks', async () => {
    const fresh = await invite(S2, { phone: '+972501110020' });
    const existing = await invite(S2, { phone: EXISTING.phone });
    expect(existing.status).toBe(fresh.status);
    expect(Object.keys(existing.body as object).sort()).toEqual(Object.keys(fresh.body as object).sort());
    expect((existing.body as RecipientInviteView).status).toBe('open');
    expect(texts(EXISTING.phone)).toHaveLength(1);
    expect(await count(`select count(*) as n from ops.recipient_invite_event where invite_id = '${(existing.body as RecipientInviteView).id}'`)).toBe(1);
    const items = await list(S2);
    expect(items.find((i) => i.id === (existing.body as RecipientInviteView).id)?.status).toBe('claimable');
    expect(items.find((i) => i.id === (fresh.body as RecipientInviteView).id)?.status).toBe('open');
    expect(texts(S2.phone, 'p2p.invite_claimable').length).toBeGreaterThan(0);
    const c = await claim(S2, (existing.body as RecipientInviteView).id);
    expect(c.body).toMatchObject({ recipient: { partyId: EXISTING.id, displayName: 'Dana E.', canReceive: true } });
  });

  it('an invitee who joins after the 14 days finds the invite expired: nothing is claimable, nobody is told, and a new invite is a new invite', async () => {
    const late = mk('+972501110030');
    const open = (await invite(S2, { phone: late.phone })).body as RecipientInviteView;
    const joined = mk('+972501110031');
    const claimableOne = (await invite(S2B, { phone: joined.phone })).body as RecipientInviteView;
    await join(joined);
    expect((await list(S2B)).find((i) => i.id === claimableOne.id)?.status).toBe('claimable');
    now = new Date(T0.getTime() + INVITE_TTL_MS + 1000);
    expect((await claim(S2B, claimableOne.id)).status).toBe(409); // claimable, but past its 14 days
    expect((await list(S2B)).find((i) => i.id === claimableOne.id)?.status).toBe('expired');
    const told = texts(S2.phone, 'p2p.invite_claimable').length;
    await join(late);
    const mine = await list(S2);
    expect(mine.find((i) => i.id === open.id)?.status).toBe('expired');
    expect(texts(S2.phone, 'p2p.invite_claimable')).toHaveLength(told);
    expect((await claim(S2, open.id)).status).toBe(409);
    // The sealed copy is gone once the invite has ended.
    expect(await count(`select count(*) as n from ops.recipient_invite where id in ('${open.id}', '${claimableOne.id}') and phone_sealed is not null`)).toBe(0);
    const again = await invite(S2, { phone: late.phone });
    expect(again.status).toBe(201);
    expect((again.body as RecipientInviteView).id).not.toBe(open.id);
    expect(texts(late.phone)).toHaveLength(2);
  });
});

describe('T-1104 the state machine and the flag', () => {
  it('keeps one history row per state, in order, that the app role can neither change nor delete; who and which phone can never change', async () => {
    const dana = mk('+972501110040');
    const inv = (await invite(S3, { phone: dana.phone })).body as RecipientInviteView;
    await join(dana);
    await claim(S3, inv.id);
    const events = (await db.query<{ from_status: string | null; to_status: string }>('select from_status, to_status from ops.recipient_invite_event where invite_id = $1 order by id', [inv.id])).rows;
    expect(events).toEqual([{ from_status: null, to_status: 'open' }, { from_status: 'open', to_status: 'claimable' }, { from_status: 'claimable', to_status: 'claimed' }]);
    await expect(db.asRole('club_app', (c) => c.query(`update ops.recipient_invite_event set to_status = 'open' where invite_id = $1`, [inv.id]))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query('delete from ops.recipient_invite_event where invite_id = $1', [inv.id]))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query('delete from ops.recipient_invite where id = $1', [inv.id]))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query(`update ops.recipient_invite set sender_party_id = $2 where id = $1`, [inv.id, OTHER.id]))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query(`update ops.recipient_invite set phone_index = decode(repeat('00', 32), 'hex') where id = $1`, [inv.id]))).rejects.toThrow(/permission denied/);
    // A state is entered once, whoever races for it.
    await expect(db.query(`insert into ops.recipient_invite_event (invite_id, from_status, to_status, at) values ($1, 'claimable', 'claimed', now())`, [inv.id])).rejects.toThrow();
  });

  it('two claims at once are one claim: one transition, one history row, the same answer', async () => {
    const dana = mk('+972501110041');
    const inv = (await invite(S3, { phone: dana.phone })).body as RecipientInviteView;
    await join(dana);
    const [a, b, c] = await Promise.all([claim(S3, inv.id), claim(S3, inv.id), claim(S3, inv.id)]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(b.body).toEqual(a.body);
    expect(await count(`select count(*) as n from ops.recipient_invite_event where invite_id = '${inv.id}' and to_status = 'claimed'`)).toBe(1);
  });

  it('with the flag off every invite route answers FEATURE_OFF 404 and nothing is created or sent', async () => {
    const before = await count('select count(*) as n from ops.recipient_invite');
    const sent = sim().sent.length;
    expect(await invite(S3, { phone: '+972501110050' }, off)).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF' } });
    expect(await call(S3, 'GET', '/v1/p2p/recipient-invites', undefined, off)).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF' } });
    expect(await call(S3, 'POST', `/v1/p2p/recipient-invites/${uuidv7(T0)}/claim`, undefined, off)).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF' } });
    expect(await count('select count(*) as n from ops.recipient_invite')).toBe(before);
    expect(sim().sent).toHaveLength(sent);
  });

  it('claiming an invite that is not yours or does not exist is the same 404', async () => {
    const mine = (await invite(S3, { phone: '+972501110051' })).body as RecipientInviteView;
    const a = await claim(OTHER, mine.id);
    const b = await claim(OTHER, uuidv7(T0));
    expect(a.status).toBe(404);
    expect(problem(a)).toEqual(problem(b));
  });
});

describe('T-1104 review round 1', () => {
  const unavailable = () => new NotifyError('PROVIDER_UNAVAILABLE', 'Simulated channel outage');

  it('a failing notice to the sender at the KYC webhook never fails the invitee\'s event: the decision is applied once, the invite is claimable, and the next list tells the sender exactly once', async () => {
    const invitee = mk('+972501110060');
    const inv = (await invite(S4, { phone: invitee.phone })).body as RecipientInviteView;
    await join(invitee, false);
    const kyc = await app.services.kyc.start(invitee.id, 'T1', `kyc-join-${invitee.id}`, now);
    const apply = vi.spyOn(app.services.kyc, 'applyDecision');
    const cards = vi.spyOn(app.services.cards, 'onKycDecision');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const told0 = texts(S4.phone, 'p2p.invite_claimable').length;
    const send = vi.spyOn(sim(), 'send').mockRejectedValue(unavailable());
    const hook = { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-${invitee.id}`, sessionId: kyc.sessionId, status: 'approved' }), now };
    expect((await dispatch(app, hook)).status).toBeLessThan(300);
    expect((await dispatch(app, hook)).status).toBeLessThan(300); // a replay does not re-run the decision
    expect([apply.mock.calls.length, cards.mock.calls.length]).toEqual([1, 1]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain(inv.id);
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).not.toContain('1110060');
    send.mockRestore();
    expect(await count(`select count(*) as n from ops.recipient_invite where id = '${inv.id}' and status = 'claimable' and sender_told_at is null`)).toBe(1);
    expect(texts(S4.phone, 'p2p.invite_claimable')).toHaveLength(told0);
    expect((await list(S4)).find((i) => i.id === inv.id)?.status).toBe('claimable'); // the retry: told now
    await list(S4);
    await claim(S4, inv.id);
    expect(texts(S4.phone, 'p2p.invite_claimable')).toHaveLength(told0 + 1);
    expect(await count(`select count(*) as n from ops.recipient_invite where id = '${inv.id}' and sender_told_at is not null`)).toBe(1);
  });

  it('one invite whose notice fails does not stall the others for the same invitee', async () => {
    const invitee = mk('+972501110061');
    const a = (await invite(S5, { phone: invitee.phone })).body as RecipientInviteView;
    const b = (await invite(S6, { phone: invitee.phone })).body as RecipientInviteView;
    await join(invitee, false);
    const real = sim().send.bind(sim());
    vi.spyOn(sim(), 'send').mockImplementation(async (n, k) => (n.to === S5.phone ? Promise.reject(unavailable()) : real(n, k)));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kyc = await app.services.kyc.start(invitee.id, 'T1', `kyc-join-${invitee.id}`, now);
    const r = await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-${invitee.id}`, sessionId: kyc.sessionId, status: 'approved' }), now });
    expect(r.status).toBeLessThan(300);
    expect(await count(`select count(*) as n from ops.recipient_invite where id in ('${a.id}', '${b.id}') and status = 'claimable'`)).toBe(2);
    expect(await count(`select count(*) as n from ops.recipient_invite where id = '${b.id}' and sender_told_at is not null`)).toBe(1);
  });

  it('a text that fails on create answers 503 and leaves an open invite; asking again sends the text exactly once', async () => {
    vi.spyOn(sim(), 'send').mockRejectedValueOnce(unavailable());
    const first = await invite(S7, { phone: '+972501110062' });
    expect(first).toMatchObject({ status: 503, body: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(texts('+972501110062')).toHaveLength(0);
    expect((await list(S7)).map((i) => i.status)).toEqual(['open']);
    const again = await invite(S7, { phone: '+972501110062' });
    const third = await invite(S7, { phone: '+972501110062' });
    expect([again.status, third.status]).toEqual([200, 200]);
    expect(texts('+972501110062')).toHaveLength(1);
    expect(await count(`select count(*) as n from ops.recipient_invite where sender_party_id = '${S7.id}'`)).toBe(1);
  });

  it('the daily cap is judged while the sender\'s advisory lock (hashtextextended, one bigint key) is held, and under READ COMMITTED', async () => {
    const seen: { locked: boolean; level: string }[] = [];
    const spy = {
      query: db.query,
      transaction: <T,>(fn: Parameters<typeof db.transaction<T>>[0]) =>
        db.transaction(async (tx) => {
          const out = await fn(tx);
          const l = await tx.query<{ locked: boolean; level: string }>(
            `select exists (select 1 from pg_locks where locktype = 'advisory' and granted and ((classid::bigint << 32) | objid::bigint) = hashtextextended('recipient-invite:' || $1::text, 0)) as locked, current_setting('transaction_isolation') as level`,
            [S7.id],
          );
          seen.push(l.rows[0]!);
          return out;
        }),
    };
    const locked = createApp({ db: spy, registry: host.registry, market: 'IL', signingKey, issuer: 'https://api.kesher.example', clock: () => now, identity: app.services.identity, flags: new StaticFlags(undefined, { 'p2p.enabled': true, 'phase1.recipientInvite': true }) });
    expect((await invite(S7, { phone: '+972501110063' }, locked)).status).toBe(201);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.level === 'read committed')).toBe(true);
    expect(seen[0]!.locked).toBe(true);
  });

  it('list and claim look a number up at most RECONCILE_PER_CALL at a time and each invite at most once a minute; a claim of one invite always checks it', async () => {
    expect(RECONCILE_PER_CALL).toBeGreaterThanOrEqual(1);
    const lookups = vi.spyOn(app.services.identity, 'findUserByPhone');
    const open = (await list(S5)).filter((i) => i.status === 'open').length; // S5 has none open: its invitee joined
    expect(open).toBe(0);
    const sender = S6;
    for (let i = 0; i < 4; i++) await invite(sender, { phone: `+97250113${String(1000 + i)}` });
    lookups.mockClear();
    await list(sender);
    const first = lookups.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(RECONCILE_PER_CALL);
    await list(sender);
    await list(sender);
    expect(lookups.mock.calls.length).toBe(first); // checked a moment ago: not again
    now = new Date(T0.getTime() + RECONCILE_EVERY_MS + 1000);
    await list(sender);
    expect(lookups.mock.calls.length).toBe(first * 2);
    const one = ((await list(sender)).find((i) => i.status === 'open'))!;
    lookups.mockClear();
    await claim(sender, one.id); // a claim checks its own invite whatever the throttle says
    expect(lookups.mock.calls.length).toBe(1);
  });

  it('a sender in the 24-hour recovery hold is refused on create, list and claim alike', async () => {
    await app.services.identity.setRestriction(HELD.id, new Date(now.getTime() + 24 * 3_600_000).toISOString(), 'otp_recovery');
    const refused = [await invite(HELD, { phone: '+972501110064' }), await list0(HELD), await claim(HELD, uuidv7(T0))];
    for (const r of refused) expect(r).toMatchObject({ status: 403, body: { code: 'RECOVERY_HOLD' } });
  });
});

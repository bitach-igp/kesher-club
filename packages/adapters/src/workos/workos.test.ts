// TST-AUTH-008 at the adapter layer (REQ-AUTH-008): institution SSO through WorkOS and SCIM
// deprovisioning through Directory Sync webhooks, against an in-memory WorkOS.
import { createHmac } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { orgIdPContract } from '@kesher/ports/contracts';
import { fakeWorkOs } from './fake-workos.ts';
import { InMemoryWorkOsStateStore, MAX_DIRECTORY_PAGES, MAX_PENDING_SSO_STATES, normaliseEvent, WorkOsOrgIdPAdapter, type WorkOsStateStore } from './workos.ts';

const timingSafeEqualCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof NodeCrypto>();
  return { ...actual, timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { timingSafeEqualCalls.n += 1; return actual.timingSafeEqual(a, b); } };
});

const API_KEY = 'sk_test_key';
const WEBHOOK_SECRET = 'whsec_test';
const ORGS = {
  org_yeshiva_a: { workosOrganizationId: 'org_workos_yeshiva', directoryId: 'directory_yeshiva', scimBearer: 'scim_org_yeshiva_a' },
  org_sem_b: { workosOrganizationId: 'org_workos_sem', scimBearer: 'scim_org_sem_b' },
  org_outage: { workosOrganizationId: 'org_workos_outage', scimBearer: 'scim_org_outage' },
};

function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const fake = fakeWorkOs({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, directories: { org_workos_yeshiva: 'directory_yeshiva', org_workos_sem: '' } });
  const adapter = new WorkOsOrgIdPAdapter({ clientId: 'client_test', apiKey: API_KEY, orgs: ORGS, webhookSecret: WEBHOOK_SECRET, fetch: fake.fetch, clock });
  return { clock, fake, adapter };
}

orgIdPContract('workos', () => setup().adapter, { orgId: 'org_yeshiva_a', scimBearer: 'scim_org_yeshiva_a', codeFor: (subject, email) => `ok:${subject}:${email}`, outageOrgId: 'org_outage' });

const redirectUri = 'https://console.kesher.example/sso/callback';

describe('WorkOsOrgIdPAdapter', () => {
  it('builds the WorkOS authorize URL for the organisation and exchanges the code with the API key', async () => {
    const { adapter, fake } = setup();
    const s = await adapter.startSso('org_yeshiva_a', { state: 'st1', redirectUri });
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe('https://api.workos.com/sso/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'client_test', redirect_uri: redirectUri, state: 'st1', organization: 'org_workos_yeshiva' });
    const id = await adapter.handleCallback({ code: 'ok:staff1:staff1@yeshiva.example:admins,finance', state: 'st1' });
    expect(id).toEqual({ orgId: 'org_yeshiva_a', subject: 'staff1', email: 'staff1@yeshiva.example', displayName: 'Staff staff1', groups: ['admins', 'finance'] });
    expect(fake.tokenRequests[0]).toMatchObject({ client_id: 'client_test', client_secret: API_KEY, grant_type: 'authorization_code', code: 'ok:staff1:staff1@yeshiva.example:admins,finance' });
  });

  it('a state is single-use and expires after 10 minutes; a bad code is INVALID_CODE', async () => {
    const { adapter, clock } = setup();
    await adapter.startSso('org_yeshiva_a', { state: 'st1', redirectUri });
    await expect(adapter.handleCallback({ code: 'nope', state: 'st1' })).rejects.toMatchObject({ code: 'INVALID_CODE' });
    await expect(adapter.handleCallback({ code: 'ok:a:a@b', state: 'st1' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await adapter.startSso('org_yeshiva_a', { state: 'st2', redirectUri });
    clock.advance(11 * 60_000);
    await expect(adapter.handleCallback({ code: 'ok:a:a@b', state: 'st2' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it("refuses a profile from another organisation's connection", async () => {
    const { adapter } = setup();
    await adapter.startSso('org_yeshiva_a', { state: 'st1', redirectUri });
    await expect(adapter.handleCallback({ code: 'ok:x:x@y;org=org_workos_sem', state: 'st1' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it('maps Directory Sync webhooks to SCIM events, dedupes by event id, and refuses other organisations', async () => {
    const { adapter } = setup();
    const envelope = { id: 'event_1', event: 'dsync.user.deleted', created_at: '2026-11-01T09:00:00Z', data: { id: 'directory_user_9', idp_id: 'staff9', organization_id: 'org_workos_yeshiva', emails: [{ primary: true, value: 'staff9@yeshiva.example' }], state: 'inactive' } };
    const a = await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', envelope);
    expect(a).toEqual({ orgId: 'org_yeshiva_a', op: 'deactivate', subject: 'staff9', email: 'staff9@yeshiva.example', active: false, occurredAt: '2026-11-01T09:00:00Z', eventId: 'event_1' });
    expect(await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', envelope)).toEqual(a);
    await expect(adapter.parseScimEvent('org_sem_b', 'scim_org_sem_b', envelope)).rejects.toMatchObject({ code: 'SCIM_UNAUTHORIZED' });
    const created = await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { id: 'event_2', event: 'dsync.user.created', data: { ...envelope.data, idp_id: 'staff10', state: 'active' } });
    expect(created).toMatchObject({ op: 'create', subject: 'staff10', active: true });
    expect(normaliseEvent({ id: 'e', event: 'dsync.user.created', data: { idp_id: 'x', state: 'active', emails: [] } })).toBeUndefined(); // creation needs an email
    expect(normaliseEvent({ eventId: 'e', op: 'retire', subject: 's', email: 'e' })).toBeUndefined();
  });

  it('lists the directory across pages and overlays deactivations the directory has not caught up with', async () => {
    const { adapter, fake } = setup();
    fake.seedDirectory('directory_yeshiva', [
      { subject: 'u1', email: 'u1@yeshiva.example' },
      { subject: 'u2', email: 'u2@yeshiva.example' },
      { subject: 'u3', email: 'u3@yeshiva.example', active: false },
    ]);
    await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'e1', op: 'deactivate', subject: 'u2', email: 'u2@yeshiva.example' });
    const dir = await adapter.listDirectory('org_yeshiva_a');
    expect(dir).toEqual([
      { subject: 'u1', email: 'u1@yeshiva.example', active: true, rawState: 'active' },
      { subject: 'u2', email: 'u2@yeshiva.example', active: false, rawState: 'inactive' },
      { subject: 'u3', email: 'u3@yeshiva.example', active: false, rawState: 'inactive' },
    ]);
    // An organisation without Directory Sync still reports webhook-driven deactivations.
    await adapter.parseScimEvent('org_sem_b', 'scim_org_sem_b', { eventId: 'e2', op: 'deactivate', subject: 'gone', email: 'gone@sem.example' });
    expect(await adapter.listDirectory('org_sem_b')).toEqual([{ subject: 'gone', email: '', active: false, rawState: 'inactive' }]);
  });

  it('an outage, a bad API key and non-JSON bodies all surface as PROVIDER_UNAVAILABLE', async () => {
    const { adapter, fake } = setup();
    fake.setOutage(true);
    await expect(adapter.startSso('org_yeshiva_a', { state: 's', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    fake.setOutage(false);
    const badKey = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: 'wrong', orgs: ORGS, fetch: fake.fetch });
    await expect(badKey.startSso('org_yeshiva_a', { state: 's', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const junk = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: 'k', orgs: ORGS, fetch: async () => new Response('<html>', { status: 200 }) });
    await expect(junk.listDirectory('org_yeshiva_a')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(() => new WorkOsOrgIdPAdapter({ clientId: '', apiKey: 'k', orgs: ORGS })).toThrow();
  });
});

// ---- T-1116 ----------------------------------------------------------------------------------------------------------------------
// Headers are built here the way WorkOS builds them (`t` in milliseconds, "t=…, v1=…"), NOT with the adapter's or the fake's helper.
const hmacHex = (t: string | number, raw: string, secret = WEBHOOK_SECRET) => createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
const RAW = '{"id":"event_01","event":"dsync.user.deleted","data":{"idp_id":"staff9"}}';

describe('verifyWebhookSignature: WorkOS-Signature t is MILLISECONDS (T-1116, TST-AUTH-008 1)', () => {
  const env = () => {
    const { adapter, clock } = setup();
    return { adapter, nowMs: clock.now().getTime() };
  };

  it('accepts a real-format header and refuses the same delivery signed with t in SECONDS (a 1970 date)', () => {
    const { adapter, nowMs } = env();
    expect(adapter.verifyWebhookSignature(`t=${nowMs}, v1=${hmacHex(nowMs, RAW)}`, RAW)).toBe(true);
    const secs = Math.floor(nowMs / 1000);
    expect(adapter.verifyWebhookSignature(`t=${secs}, v1=${hmacHex(secs, RAW)}`, RAW)).toBe(false);
    expect(adapter.verifyWebhookSignature(`t=${secs * 1000 + 0}, v1=${hmacHex(secs, RAW)}`, RAW)).toBe(false); // the signed string uses the t that was sent
  });

  it('tolerance is 5 minutes in milliseconds, on both sides, to the millisecond', () => {
    const { adapter, nowMs } = env();
    const at = (t: number) => adapter.verifyWebhookSignature(`t=${t}, v1=${hmacHex(t, RAW)}`, RAW);
    expect(at(nowMs - 300_000)).toBe(true);
    expect(at(nowMs - 300_001)).toBe(false);
    expect(at(nowMs + 300_000)).toBe(true);
    expect(at(nowMs + 300_001)).toBe(false); // future-dated beyond tolerance
    expect(at(nowMs + 3_600_000)).toBe(false);
    expect(at(0)).toBe(false);
  });

  it('header variants: whitespace, uppercase hex, several v1, unknown parts', () => {
    const { adapter, nowMs } = env();
    const good = hmacHex(nowMs, RAW);
    const bad = hmacHex(nowMs, 'other');
    for (const h of [`t=${nowMs},v1=${good}`, `  t=${nowMs}  ,   v1=${good}  `, `t=${nowMs}, v1=${good.toUpperCase()}`, `v1=${good}, t=${nowMs}`, `t=${nowMs}, v1=${bad}, v1=${good}`, `t=${nowMs}, v1=${good}, v1=${bad}`, `t=${nowMs}, v0=zz, v1=${good}`]) expect(adapter.verifyWebhookSignature(h, RAW), h).toBe(true);
  });

  it('refuses missing, duplicated and malformed parts', () => {
    const { adapter, nowMs } = env();
    const good = hmacHex(nowMs, RAW);
    const refused = [
      '', `v1=${good}`, `t=${nowMs}`, `t=${nowMs}, v1=`, `t=${nowMs}, v1=${good.slice(1)}`, `t=${nowMs}, v1=${good}0`, `t=${nowMs}, v1=${'z'.repeat(64)}`,
      `t=, v1=${good}`, `t=abc, v1=${good}`, `t=-${nowMs}, v1=${good}`, `t=${nowMs}.5, v1=${good}`, `t=0x1, v1=${good}`, `t=${nowMs}, t=${nowMs}, v1=${good}`,
      `t=${nowMs}, junk, v1=${good}`, `t=${nowMs}, v1=${good},`, `t=${nowMs}, v1=${bad2(good)}`, `t=${'9'.repeat(30)}, v1=${good}`, `${'a'.repeat(3000)}`,
    ];
    for (const h of refused) expect(adapter.verifyWebhookSignature(h, RAW), h.slice(0, 40)).toBe(false);
    expect(adapter.verifyWebhookSignature(undefined as never, RAW)).toBe(false);
    expect(adapter.verifyWebhookSignature(`t=${nowMs}, v1=${good}`, undefined as never)).toBe(false);
  });

  it('hashes the raw body exactly: a re-serialised or altered body fails, UTF-8 bodies verify, a wrong or missing secret fails', () => {
    const { adapter, nowMs, } = env();
    const raw = '{ "id" : "event_01",  "note": "שלום ✓" }';
    const header = `t=${nowMs}, v1=${hmacHex(nowMs, raw)}`;
    expect(adapter.verifyWebhookSignature(header, raw)).toBe(true);
    expect(adapter.verifyWebhookSignature(header, JSON.stringify(JSON.parse(raw)))).toBe(false); // same data, different bytes
    expect(adapter.verifyWebhookSignature(header, `${raw} `)).toBe(false);
    expect(adapter.verifyWebhookSignature(`t=${nowMs}, v1=${hmacHex(nowMs, raw, 'whsec_other')}`, raw)).toBe(false);
    const { fake, clock } = setup();
    const noSecret = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: 'k', orgs: ORGS, fetch: fake.fetch, clock });
    expect(noSecret.verifyWebhookSignature(header, raw)).toBe(false);
    // the signed string is `${t}.${body}` with the t as sent (a leading zero is part of it)
    const padded = `0${nowMs}`;
    expect(adapter.verifyWebhookSignature(`t=${padded}, v1=${hmacHex(padded, raw)}`, raw)).toBe(true);
    expect(adapter.verifyWebhookSignature(`t=${padded}, v1=${hmacHex(nowMs, raw)}`, raw)).toBe(false);
  });

  it('compares every v1 candidate in constant time (timingSafeEqual, no short-circuit)', () => {
    const { adapter, nowMs } = env();
    const good = hmacHex(nowMs, RAW);
    const before = timingSafeEqualCalls.n;
    expect(adapter.verifyWebhookSignature(`t=${nowMs}, v1=${good}, v1=${hmacHex(nowMs, 'x')}, v1=${hmacHex(nowMs, 'y')}`, RAW)).toBe(true);
    expect(timingSafeEqualCalls.n - before).toBe(3);
  });

  it('the fake WorkOS signs the real format too (ms, comma and space)', () => {
    const { fake, clock, adapter } = setup();
    const ms = clock.now().getTime();
    expect(fake.sign(RAW, ms)).toBe(`t=${ms}, v1=${hmacHex(ms, RAW)}`);
    expect(adapter.verifyWebhookSignature(fake.sign(RAW, ms), RAW)).toBe(true);
  });
});
const bad2 = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

describe('a removal needs no email (T-1116, TST-AUTH-008 2)', () => {
  const shaped = (event: string, data: Record<string, unknown>) => ({ id: 'event_ne', event, created_at: '2026-11-01T09:00:00Z', data: { object: 'directory_user', id: 'directory_user_1', directory_id: 'directory_yeshiva', organization_id: 'org_workos_yeshiva', idp_id: 'staff9', first_name: null, last_name: null, state: 'inactive', ...data } });

  it('deleted and a deactivating update normalise with no emails array, an empty one, null or a malformed one; the subject stays mandatory', () => {
    for (const emails of ['omit', [], null, [{}], [{ primary: true }], 'x', [null]]) {
      const data = emails === 'omit' ? {} : { emails };
      expect(normaliseEvent(shaped('dsync.user.deleted', data)), JSON.stringify(emails)).toMatchObject({ op: 'deactivate', subject: 'staff9', email: '', active: false, eventId: 'event_ne' });
      expect(normaliseEvent(shaped('dsync.user.updated', data)), JSON.stringify(emails)).toMatchObject({ op: 'update', subject: 'staff9', email: '', active: false });
    }
    expect(normaliseEvent(shaped('dsync.user.deleted', { idp_id: undefined }))).toBeUndefined();
    expect(normaliseEvent(shaped('dsync.user.deleted', { idp_id: '' }))).toBeUndefined();
    expect(normaliseEvent(shaped('dsync.user.deleted', { idp_id: 7 }))).toBeUndefined();
    expect(normaliseEvent({ ...shaped('dsync.user.deleted', {}), id: undefined })).toBeUndefined();
    expect(normaliseEvent({ ...shaped('dsync.user.deleted', {}), data: null })).toBeUndefined();
  });

  it('a still-present email is carried; created and an active update need one; an unrecognised update state is malformed, never a removal', () => {
    const mail = { emails: [{ primary: false, value: 'b@x' }, { primary: true, value: 'a@x' }] };
    expect(normaliseEvent(shaped('dsync.user.deleted', mail))).toMatchObject({ email: 'a@x' });
    expect(normaliseEvent(shaped('dsync.user.created', { ...mail, state: 'active' }))).toMatchObject({ op: 'create', active: true, email: 'a@x' });
    expect(normaliseEvent(shaped('dsync.user.created', { state: 'active' }))).toBeUndefined();
    expect(normaliseEvent(shaped('dsync.user.created', { state: 'active', emails: [] }))).toBeUndefined();
    expect(normaliseEvent(shaped('dsync.user.updated', { state: 'active' }))).toBeUndefined();
    expect(normaliseEvent(shaped('dsync.user.updated', { ...mail, state: 'active' }))).toMatchObject({ op: 'update', active: true });
    for (const state of ['suspended', undefined, 'ACTIVE', 5]) expect(normaliseEvent(shaped('dsync.user.updated', { ...mail, state })), String(state)).toBeUndefined();
    expect(normaliseEvent(shaped('dsync.user.created', { ...mail, state: 'suspended' }))).toMatchObject({ op: 'create', active: false });
  });

  it('the adapter turns them into a deactivation, marks the subject inactive, and still refuses another organisation', async () => {
    const { adapter } = setup();
    const e = await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', shaped('dsync.user.deleted', { emails: [] }));
    expect(e).toEqual({ orgId: 'org_yeshiva_a', op: 'deactivate', subject: 'staff9', email: '', active: false, occurredAt: '2026-11-01T09:00:00Z', eventId: 'event_ne' });
    expect((await adapter.listDirectory('org_sem_b')).length).toBe(0);
    await expect(adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { ...shaped('dsync.user.created', { state: 'active' }), id: 'event_c' })).rejects.toMatchObject({ code: 'SCIM_MALFORMED' });
    await expect(adapter.parseScimEvent('org_sem_b', 'scim_org_sem_b', shaped('dsync.user.deleted', {}))).rejects.toMatchObject({ code: 'SCIM_UNAUTHORIZED' });
    // the port's own relay shape: a deactivation needs no email either, a creation does
    expect(await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'r1', op: 'deactivate', subject: 's1' })).toMatchObject({ subject: 's1', email: '', active: false });
    await expect(adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'r2', op: 'create', subject: 's2' })).rejects.toMatchObject({ code: 'SCIM_MALFORMED' });
  });
});

describe('listDirectory fails closed (T-1116, TST-AUTH-008 3 and 4)', () => {
  const ORG = 'org_yeshiva_a';
  const user = (i: number, state: unknown = 'active') => ({ id: `du_${i}`, idp_id: `u${i}`, organization_id: 'org_workos_yeshiva', emails: [{ primary: true, value: `u${i}@x` }], state });
  /** A fetch whose directory pages come from `page(n, after)`; the connection probe is not needed for reads. */
  const reading = (page: (n: number, after: string | null) => Response | Promise<Response>, over: { requestTimeoutMs?: number } = {}) => {
    let n = 0;
    const calls: (string | null)[] = [];
    const fetchStub: typeof fetch = async (input) => {
      const after = new URL(String(input)).searchParams.get('after');
      calls.push(after);
      return page(n++, after);
    };
    return { calls, adapter: new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: API_KEY, orgs: ORGS, fetch: fetchStub, clock: fixedClock(), ...over }) };
  };
  const ok = (data: unknown, after: unknown = null, meta = true) => Response.json({ ...(data === undefined ? {} : { data }), ...(meta ? { list_metadata: { before: null, after } } : {}) });
  const unavailable = { code: 'PROVIDER_UNAVAILABLE' };

  it('a page with no data, null, an object, a string or a number is a FAILED read, never an empty page', async () => {
    for (const data of [undefined, null, { a: 1 }, 'x', 7]) {
      const { adapter } = reading(() => ok(data));
      await expect(adapter.listDirectory(ORG), String(data)).rejects.toMatchObject(unavailable);
    }
    await expect(reading(() => Response.json([user(1)])).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable); // a bare array
    await expect(reading(() => Response.json(null)).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
  });

  it('a later page that fails (no data, 500, non-JSON) fails the whole read: users beyond page 1 are never read as absent', async () => {
    for (const second of [() => ok(undefined), () => new Response('', { status: 500 }), () => new Response('<html>', { status: 200 }), () => ok(null, null)]) {
      const { adapter } = reading((n) => (n === 0 ? ok([user(1), user(2)], 'c1') : second()));
      await expect(adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    }
  });

  it('a missing list_metadata, a missing or wrongly typed after, and an empty cursor fail the read', async () => {
    await expect(reading(() => ok([user(1)], null, false)).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    for (const after of [undefined, 5, true, {}, [], '']) {
      await expect(reading(() => Response.json({ data: [user(1)], list_metadata: after === undefined ? {} : { after } })).adapter.listDirectory(ORG), String(after)).rejects.toMatchObject(unavailable);
    }
    await expect(reading(() => Response.json({ data: [user(1)], list_metadata: 'x' })).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
  });

  it('a cursor that repeats (immediately or later in the chain) fails the read', async () => {
    const same = reading(() => ok([user(1)], 'c1'));
    await expect(same.adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    expect(same.calls).toEqual([null, 'c1']);
    const loop = reading((n) => ok([user(n)], ['c1', 'c2', 'c1'][n]));
    await expect(loop.adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    expect(loop.calls).toEqual([null, 'c1', 'c2']);
  });

  it(`a never-ending chain of fresh cursors stops at ${MAX_DIRECTORY_PAGES} pages and fails; a chain of exactly ${MAX_DIRECTORY_PAGES} pages is read`, async () => {
    const endless = reading((n) => ok([user(n)], `c${n}`));
    await expect(endless.adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    expect(endless.calls.length).toBe(MAX_DIRECTORY_PAGES);
    const full = reading((n) => ok([user(n)], n === MAX_DIRECTORY_PAGES - 1 ? null : `c${n}`));
    expect((await full.adapter.listDirectory(ORG)).length).toBe(MAX_DIRECTORY_PAGES);
    expect(full.calls.length).toBe(MAX_DIRECTORY_PAGES);
  });

  it('a hung page, a hung body, a stub that ignores the abort signal and a rejected fetch are failed reads', async () => {
    const never = new Promise<Response>(() => undefined);
    await expect(reading(() => never, { requestTimeoutMs: 15 }).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    await expect(reading((n) => (n === 0 ? ok([user(1)], 'c1') : never), { requestTimeoutMs: 15 }).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    const hungBody = { ok: true, status: 200, json: () => new Promise(() => undefined) } as unknown as Response;
    await expect(reading(() => hungBody, { requestTimeoutMs: 15 }).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    await expect(reading(() => Promise.reject(new Error('socket'))).adapter.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    // the signal is handed to fetch and fires on timeout
    let signal: AbortSignal | undefined;
    const a = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: API_KEY, orgs: ORGS, requestTimeoutMs: 15, fetch: async (_i, init) => { signal = init?.signal ?? undefined; return never; } });
    await expect(a.listDirectory(ORG)).rejects.toMatchObject(unavailable);
    expect(signal?.aborted).toBe(true);
  });

  it('a fast read is not cut off by the budget', async () => {
    const { adapter } = reading(() => ok([user(1)]), { requestTimeoutMs: 1000 });
    expect(await adapter.listDirectory(ORG)).toHaveLength(1);
  });

  it('exposes the raw state: active, inactive, a new value and none; only an exact active is active', async () => {
    const { adapter } = reading(() => ok([user(1, 'active'), user(2, 'inactive'), user(3, 'suspended'), { ...user(4), state: undefined }, user(5, 'ACTIVE'), user(6, null)]));
    const dir = await adapter.listDirectory(ORG);
    expect(dir.map((d) => [d.subject, d.active, d.rawState])).toEqual([['u1', true, 'active'], ['u2', false, 'inactive'], ['u3', false, 'suspended'], ['u4', false, undefined], ['u5', false, 'ACTIVE'], ['u6', false, undefined]]);
  });

  it('a user the directory lists active but a webhook deactivated reads as inactive (raw state included); a listed twice user is active if either entry is', async () => {
    const { adapter } = reading((n) => (n === 0 ? ok([user(1), user(2)], 'c1') : ok([user(2, 'inactive'), { ...user(1), state: 'inactive' }])));
    await adapter.parseScimEvent(ORG, 'scim_org_yeshiva_a', { eventId: 'e9', op: 'deactivate', subject: 'u2' });
    const dir = await adapter.listDirectory(ORG);
    expect(dir.find((d) => d.subject === 'u2')).toMatchObject({ active: false, rawState: 'inactive' });
    expect(dir.find((d) => d.subject === 'u1')).toMatchObject({ active: true, rawState: 'active' }); // listed active, then inactive
  });

  it('an entry with no usable idp_id is passed on as an unusable entry (the sweep counts it as malformed), not dropped', async () => {
    const { adapter } = reading(() => ok([user(1), null, { id: 'x' }, { idp_id: 4 }, 'str']));
    const dir = await adapter.listDirectory(ORG);
    expect(dir.filter((d) => d.subject === '').length).toBe(4);
    expect(dir.filter((d) => d.subject !== '').length).toBe(1);
  });

  it('an organisation without a directory id still answers only what the webhooks taught, with their raw state', async () => {
    const { adapter } = setup();
    expect(await adapter.listDirectory('org_sem_b')).toEqual([]);
  });
});

describe('adapter state behind an injectable store (T-1116 5)', () => {
  const twin = (store: WorkOsStateStore) => {
    const { fake, clock } = setup();
    const mk = () => new WorkOsOrgIdPAdapter({ clientId: 'client_test', apiKey: API_KEY, orgs: ORGS, webhookSecret: WEBHOOK_SECRET, fetch: fake.fetch, clock, store });
    return { a: mk(), b: mk(), clock };
  };

  it('with one shared store, a sign-in started on instance A completes on instance B, once', async () => {
    const { a, b } = twin(new InMemoryWorkOsStateStore());
    await a.startSso('org_yeshiva_a', { state: 'st-shared', redirectUri });
    const id = await b.handleCallback({ code: 'ok:staff1:staff1@yeshiva.example', state: 'st-shared' });
    expect(id).toMatchObject({ orgId: 'org_yeshiva_a', subject: 'staff1' });
    await expect(a.handleCallback({ code: 'ok:staff1:staff1@yeshiva.example', state: 'st-shared' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it('a deactivation learned by one instance refuses SSO and shows in the directory on the other', async () => {
    const { a, b } = twin(new InMemoryWorkOsStateStore());
    await a.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'e1', op: 'deactivate', subject: 'staff3' });
    await b.startSso('org_yeshiva_a', { state: 'st-b', redirectUri });
    await expect(b.handleCallback({ code: 'ok:staff3:staff3@yeshiva.example', state: 'st-b' })).rejects.toMatchObject({ code: 'INVALID_CODE' });
    expect(await b.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'e1', op: 'deactivate', subject: 'staff3' })).toMatchObject({ eventId: 'e1' }); // the seen event is shared too
    await a.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'e2', op: 'update', subject: 'staff3', email: 'staff3@yeshiva.example', active: true });
    await b.startSso('org_yeshiva_a', { state: 'st-b2', redirectUri });
    await expect(b.handleCallback({ code: 'ok:staff3:staff3@yeshiva.example', state: 'st-b2' })).resolves.toMatchObject({ subject: 'staff3' });
  });

  it('two sign-ins started at the same instant are both pending (a state is not born expired)', async () => {
    const { a, b } = twin(new InMemoryWorkOsStateStore());
    await a.startSso('org_yeshiva_a', { state: 'st-1', redirectUri });
    await b.startSso('org_yeshiva_a', { state: 'st-2', redirectUri });
    await expect(a.handleCallback({ code: 'ok:s1:s1@y.example', state: 'st-1' })).resolves.toMatchObject({ subject: 's1' });
    await expect(b.handleCallback({ code: 'ok:s2:s2@y.example', state: 'st-2' })).resolves.toMatchObject({ subject: 's2' });
  });

  it('a replayed older event does not undo a later one (seen event ids answer with their first result)', async () => {
    const { a, b } = twin(new InMemoryWorkOsStateStore());
    const off = { eventId: 'e1', op: 'deactivate', subject: 'staff4' };
    await a.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', off);
    await a.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'e2', op: 'update', subject: 'staff4', email: 'staff4@y.example', active: true });
    await b.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', off); // the vendor re-delivers e1 after e2
    await b.startSso('org_yeshiva_a', { state: 'st-r', redirectUri });
    await expect(b.handleCallback({ code: 'ok:staff4:staff4@y.example', state: 'st-r' })).resolves.toMatchObject({ subject: 'staff4' });
  });

  it('separate default stores do NOT share (the documented single-process limit): the callback on another instance is STATE_MISMATCH', async () => {
    const x = setup().adapter;
    const y = setup().adapter;
    await x.startSso('org_yeshiva_a', { state: 'st-lone', redirectUri });
    await expect(y.handleCallback({ code: 'ok:staff1:staff1@yeshiva.example', state: 'st-lone' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it('the in-memory store is bounded: 5000 unauthenticated starts hold at most the cap, oldest out, and expired states are swept', async () => {
    const store = new InMemoryWorkOsStateStore();
    for (let i = 0; i < 5000; i++) await store.putState(`s${i}`, { orgId: 'o', issuedAt: 1_000 }, 600_000);
    expect(store.size).toBe(MAX_PENDING_SSO_STATES);
    expect(await store.takeState('s0')).toBeUndefined();
    expect(await store.takeState('s4999')).toEqual({ orgId: 'o', issuedAt: 1_000 });
    expect(await store.takeState('s4999')).toBeUndefined(); // single use
    await store.putState('late', { orgId: 'o', issuedAt: 1_000 + 600_001 }, 600_000);
    expect(store.size).toBe(1); // everything older than the TTL went with the put
    const kept = new InMemoryWorkOsStateStore();
    await kept.putState('old', { orgId: 'o', issuedAt: 1_000 }, 600_000);
    await kept.putState('new', { orgId: 'o', issuedAt: 600_999 }, 600_000);
    expect(kept.size).toBe(2); // not yet expired at 600_999 (expires at 601_000)
    await kept.putState('s', { orgId: 'o', issuedAt: 1_000 + 600_000 }, 600_000);
    expect(kept.size).toBe(2); // expired exactly at issued+ttl: `old` is gone
  });

  it('deactivations are never evicted, and seen event ids are bounded', async () => {
    const store = new InMemoryWorkOsStateStore();
    await store.markDeactivated('o', 'gone');
    for (let i = 0; i < 12_000; i++) await store.putEvent('o', `e${i}`, { orgId: 'o', op: 'update', subject: 's', email: '', active: true, occurredAt: 't', eventId: `e${i}` });
    expect(await store.isDeactivated('o', 'gone')).toBe(true);
    expect(await store.getEvent('o', 'e0')).toBeUndefined();
    expect((await store.getEvent('o', 'e11999'))?.eventId).toBe('e11999');
    expect(await store.listDeactivated('o')).toEqual(['gone']);
    await store.clearDeactivated('o', 'gone');
    expect(await store.isDeactivated('o', 'gone')).toBe(false);
  });

  it('at the adapter, a flood of starts evicts the oldest pending state, not the newest', async () => {
    const { adapter } = setup();
    for (let i = 0; i < MAX_PENDING_SSO_STATES + 1; i++) await adapter.startSso('org_yeshiva_a', { state: `flood-${i}`, redirectUri });
    await expect(adapter.handleCallback({ code: 'ok:a:a@b', state: 'flood-0' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await expect(adapter.handleCallback({ code: 'ok:a:a@b', state: `flood-${MAX_PENDING_SSO_STATES}` })).resolves.toMatchObject({ subject: 'a' });
  }, 30_000);
});


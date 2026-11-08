// T-0065: legal documents through the two-person flow. TST-LEGAL-065 (no REQ row): one admin cannot publish alone (the proposer
// approving their own request is refused); a second admin's approval publishes exactly once and is audited; approving again
// publishes nothing more; an unapproved or expired proposal publishes nothing; a non-admin gets 403; an effective date in the
// past is 422; the published version appears in GET /legal/documents from its effective date and not before.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { AUDIT_CHAIN_LOCK } from '../audit/service.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { LegalService } from './service.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
let clockNow: Date;
const t0 = new Date('2026-11-10T09:00:00Z');
const DAY = 86_400_000;
const A = { sub: 'admin-a', roles: ['admin'] };
const B = { sub: 'admin-b', roles: ['admin'] };

const token = (sub: string, roles: string[], at: Date) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(at.getTime() / 1000)).setExpirationTime(Math.floor(at.getTime() / 1000) + 300).sign(privateKey);
let memberToken = '';
const call = async (who: { sub: string; roles: string[] } | 'member' | undefined, method: string, url: string, body?: unknown, at = t0) => {
  clockNow = at; // the staff token is checked against the app's clock
  return dispatch(app, { method, url: `/v1${url}`, headers: who === 'member' ? { authorization: `Bearer ${memberToken}` } : who ? { authorization: `Bearer ${await token(who.sub, who.roles, at)}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now: at });
};
const draft = (text: string, over: Record<string, unknown> = {}) => ({
  docKey: 'terms',
  title: { en: 'Terms of use', he: 'תנאי שימוש' },
  body: { en: text, he: `${text} (he)` },
  material: true,
  changeSummary: { en: 'What changed', he: 'מה השתנה' },
  effectiveAt: new Date(t0.getTime() + 7 * DAY).toISOString(),
  ...over,
});
const versions = async (docKey = 'terms') => (await db.query<{ version: number }>('select version from legal.document_version where doc_key = $1 order by version', [docKey])).rows.map((r) => r.version);
const inForce = async (at: Date) => ((await call(undefined, 'GET', '/legal/documents', undefined, at)).body as { items: { docKey: string; version: number; body: { en: string } }[] }).items;
type Proposal = { id: string; status: string; approvals: number; requestedBy: string; published?: { version: number; hash: string } };

beforeAll(async () => {
  clockNow = t0;
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => clockNow });
  memberToken = (await app.services.tokens.issue({ partyId: uuidv7(t0), deviceId: 'phone-1', roles: ['member'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

const post = (who: Parameters<typeof call>[0], d: unknown, at = t0) => call(who, 'POST', '/admin/legal/documents', d, at);
const approve = (who: Parameters<typeof call>[0], id: string, at = t0) => call(who, 'POST', `/admin/legal/documents/${id}/approve`, undefined, at);
const code = (r: { body?: unknown }) => (r.body as { code: string }).code;
const requests = async () => (await db.query<{ id: string; status: string; payload: Record<string, unknown> }>(`select id, status, payload from ops.approval_request where kind = 'legal_publish' order by created_at, id`)).rows;

// Every test starts from no versions and no requests (the audit chain is append-only and is left alone).
beforeEach(async () => {
  clockNow = t0;
  await db.query('delete from legal.consent');
  await db.query('delete from legal.document_version');
  await db.query('delete from ops.approval_decision');
  await db.query('delete from ops.approval_request');
});

describe('legal documents: propose and approve (TST-LEGAL-065, T-0065)', () => {
  it('a non-staff session (a member) gets 403 and no token 401, on both routes; every staff token is an admin (staff-token.ts)', async () => {
    expect((await post('member', draft('v1'))).status).toBe(403);
    expect((await post(undefined, draft('v1'))).status).toBe(401);
    expect((await approve('member', '0192f3a4-0000-7000-8000-000000000000')).status).toBe(403);
    expect(await versions()).toEqual([]);
    expect(await requests()).toEqual([]);
  });

  it('one admin cannot publish alone: the proposer counts once, approving their own request is 409, and nothing is published', async () => {
    const r = await post(A, draft('terms v1'));
    expect(r.status).toBe(201);
    const p = r.body as Proposal;
    expect(p).toMatchObject({ status: 'awaiting_second_approval', approvals: 1, docKey: 'terms', material: true });
    const self = await approve(A, p.id);
    expect([self.status, code(self)]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect(await versions()).toEqual([]);
  });

  it('the same draft while open answers the existing request, to a double-click or the other admin, and makes no second', async () => {
    const first = (await post(A, draft('terms v1'))).body as Proposal;
    const again = await post(A, draft('terms v1'));
    const other = await post(B, draft('terms v1'));
    expect([again.status, other.status]).toEqual([200, 200]);
    expect((again.body as Proposal).id).toBe(first.id);
    expect(other.body).toMatchObject({ id: first.id, approvals: 1, status: 'awaiting_second_approval' });
    expect(await requests()).toHaveLength(1);
  });

  it('a corrected draft (title, material, summary or date changed) is a new request carrying the corrected payload', async () => {
    const first = (await post(A, draft('terms v1'))).body as Proposal;
    const fixed = await post(A, draft('terms v1', { title: { en: 'Terms (fixed)', he: 'תנאים' }, material: false, effectiveAt: new Date(t0.getTime() + 9 * DAY).toISOString() }));
    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ title: { en: 'Terms (fixed)' }, material: false, effectiveAt: new Date(t0.getTime() + 9 * DAY).toISOString() });
    expect((fixed.body as Proposal).id).not.toBe(first.id);
    expect(await requests()).toHaveLength(2);
    const two = await approve(B, (fixed.body as Proposal).id);
    expect(two.body).toMatchObject({ published: { version: 1, material: false, title: { en: 'Terms (fixed)' } } });
  });

  it('the same instant in another notation is the same draft', async () => {
    const first = (await post(A, draft('terms v1', { effectiveAt: '2026-11-17T09:00:00Z' }))).body as Proposal;
    const again = await post(B, draft('terms v1', { effectiveAt: '2026-11-17T11:00:00+02:00' }));
    expect([again.status, (again.body as Proposal).id]).toEqual([200, first.id]);
  });

  it('a second admin approves: it publishes once, audited, and approving again publishes nothing more', async () => {
    const id = ((await post(A, draft('terms v1'))).body as Proposal).id;
    const r = await approve(B, id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, status: 'approved', approvals: 2, published: { docKey: 'terms', version: 1, material: true, body: { en: 'terms v1', he: 'terms v1 (he)' } } });
    expect(await versions()).toEqual([1]);
    const row = (await db.query<{ published_by: string; effective_at: Date }>('select published_by, effective_at from legal.document_version where doc_key = $1', ['terms'])).rows[0]!;
    expect(row.published_by).toBe((r.body as Proposal).requestedBy);
    expect(new Date(row.effective_at).toISOString()).toBe(new Date(t0.getTime() + 7 * DAY).toISOString());
    const audit = await db.query<{ subject: string; actor_role: string }>(`select subject, actor_role from audit.entry where action = 'legal_document.publish' and payload->>'approvalId' = $1`, [id]);
    expect(audit.rows).toEqual([{ subject: 'terms:1', actor_role: 'admin' }]);
    expect((await approve(B, id)).status).toBe(409);
    expect((await approve(A, id)).status).toBe(409);
    expect(await versions()).toEqual([1]);
    expect((await db.query(`select 1 from audit.entry where payload->>'approvalId' = $1`, [id])).rows).toHaveLength(1);
  });

  it('the published version is in GET /legal/documents from its effective date and not before', async () => {
    await approve(B, ((await post(A, draft('terms v1'))).body as Proposal).id);
    expect(await inForce(t0)).toEqual([]);
    expect(await inForce(new Date(t0.getTime() + 7 * DAY - 1000))).toEqual([]);
    expect(await inForce(new Date(t0.getTime() + 7 * DAY))).toMatchObject([{ docKey: 'terms', version: 1, body: { en: 'terms v1' } }]);
  });

  it('after approval, refusal or expiry the same text can be proposed again (a rollback to an earlier text)', async () => {
    const a = (await post(A, draft('terms v1'))).body as Proposal;
    await approve(B, a.id);
    const again = await post(A, draft('terms v1'));
    expect(again.status).toBe(201);
    expect((again.body as Proposal).id).not.toBe(a.id);
    await approve(B, (again.body as Proposal).id);
    expect(await versions()).toEqual([1, 2]);

    const r = (await post(A, draft('rejected text'))).body as Proposal;
    await db.query(`update ops.approval_request set status = 'rejected' where id = $1`, [r.id]);
    expect((await post(A, draft('rejected text'))).status).toBe(201);

    const e = (await post(A, draft('expiring text'))).body as Proposal;
    const late = new Date(t0.getTime() + 8 * DAY);
    expect(code(await approve(B, e.id, late))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await post(A, draft('expiring text', { effectiveAt: new Date(late.getTime() + DAY).toISOString() }), late)).status).toBe(201);
  });

  it('an effective date in the past is 422; so are a missing language, an unknown document and a missing material flag', async () => {
    const past = await post(A, draft('past', { effectiveAt: new Date(t0.getTime() - 1000).toISOString() }));
    expect([past.status, code(past)]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await post(A, draft('x', { body: { en: 'only english', he: ' ' } }))).status).toBe(422);
    expect((await post(A, draft('x', { docKey: 'nope' }))).status).toBe(422);
    expect((await post(A, draft('x', { material: 'yes' }))).status).toBe(422);
    expect(await requests()).toEqual([]);
  });

  it('effectiveAt must be RFC 3339 with Z or an offset: a date alone, no offset, a non-ISO string or an impossible day is 422', async () => {
    for (const bad of ['2026-12-01', '2026-12-01T09:00:00', 'Dec 1 2026 09:00 UTC', '2026-02-30T09:00:00Z', '2026-12-01 09:00:00Z', 1795000000000, null]) {
      const r = await post(A, draft('fmt', { effectiveAt: bad }));
      expect([bad, r.status, code(r)]).toEqual([bad, 422, 'VALIDATION_FAILED']);
    }
    expect((await post(A, draft('fmt', { effectiveAt: '2026-12-01T09:00:00.5+02:00' }))).status).toBe(201);
  });

  it('control characters, DEL and bidirectional overrides are 422, not 500; line breaks are fine in a body and not in a title', async () => {
    for (const ch of ['\u0000', '\u0007', '\u001f', '\u007f', '\u202e', '\u202a', '\u2066', '\u2069']) {
      for (const over of [{ body: { en: `a${ch}b`, he: 'ב' } }, { title: { en: 'T', he: `ת${ch}` } }, { changeSummary: { en: `s${ch}`, he: 'ס' } }]) {
        const r = await post(A, draft('ctl', over));
        expect([JSON.stringify(over), r.status, code(r)]).toEqual([JSON.stringify(over), 422, 'VALIDATION_FAILED']);
      }
    }
    expect((await post(A, draft('ctl', { title: { en: 'two\nlines', he: 'ת' } }))).status).toBe(422);
    expect((await post(A, draft('line one\r\n\tline two'))).status).toBe(201);
    expect((await post(A, draft('ctl', { body: { en: 'x'.repeat(200_001), he: 'ב' } }))).status).toBe(422);
    expect((await post(A, draft('astral', { body: { en: '😀'.repeat(200_000), he: 'ב' } }))).status).toBe(201);
  });

  it('an unapproved proposal publishes nothing, and one that expires cannot be approved afterwards', async () => {
    const p = (await post(A, draft('privacy v1', { docKey: 'privacy' }))).body as Proposal;
    expect(await versions('privacy')).toEqual([]);
    const r = await approve(B, p.id, new Date(t0.getTime() + 8 * DAY));
    expect([r.status, code(r)]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect(await versions('privacy')).toEqual([]);
    expect((await db.query<{ status: string }>('select status from ops.approval_request where id = $1', [p.id])).rows[0]!.status).toBe('expired');
  });

  it('an approval after the effective date is refused 409 and publishes nothing; the request stays open and lapses', async () => {
    const p = (await post(A, draft('terms v2', { effectiveAt: new Date(t0.getTime() + DAY).toISOString() }))).body as Proposal;
    const r = await approve(B, p.id, new Date(t0.getTime() + 2 * DAY));
    expect([r.status, code(r)]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((r.body as { detail?: string; message?: string }).detail ?? (r.body as { message?: string }).message).toMatch(/propose the document again/);
    expect(await versions()).toEqual([]);
    expect((await requests())[0]).toMatchObject({ status: 'awaiting_second_approval' });
    expect((await db.query(`select 1 from ops.approval_decision where request_id = $1 and decided_by <> $2`, [p.id, (p as unknown as { requestedBy: string }).requestedBy])).rows).toEqual([]);
  });

  it('a version dated before one already scheduled for the same document is refused (422 to propose, 409 to approve), so it cannot shadow it', async () => {
    const far = new Date(t0.getTime() + 30 * DAY).toISOString();
    const near = new Date(t0.getTime() + 10 * DAY).toISOString();
    const first = (await post(A, draft('terms far', { effectiveAt: far }))).body as Proposal;
    // Proposed while nothing is scheduled yet, so it is accepted; the approval of the far one then makes it a shadow.
    const shadow = (await post(A, draft('terms near', { effectiveAt: near }))).body as Proposal;
    await approve(B, first.id);
    const refused = await approve(B, shadow.id);
    expect([refused.status, code(refused)]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect(await versions()).toEqual([1]);
    expect((await requests()).find((r) => r.id === shadow.id)!.status).toBe('awaiting_second_approval');
    const again = await post(A, draft('terms near 2', { effectiveAt: near }));
    expect([again.status, code(again)]).toEqual([422, 'VALIDATION_FAILED']);
    // The same date or later, or another document, is fine.
    expect((await post(A, draft('terms same day', { effectiveAt: far }))).status).toBe(201);
    expect((await post(A, draft('privacy near', { docKey: 'privacy', effectiveAt: near }))).status).toBe(201);
  });

  it('two approvals for one document number the versions N and N+1 under a per-document lock', async () => {
    const a = (await post(A, draft('terms a'))).body as Proposal;
    const b = (await post(A, draft('terms b'))).body as Proposal;
    const ra = await approve(B, a.id);
    const rb = await approve(B, b.id);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await versions()).toEqual([1, 2]);
    // PGlite has one connection, so the race itself cannot run: check that publishing holds the document's lock until commit.
    await db.transaction(async (tx) => {
      await new LegalService({ query: tx.query, transaction: async (fn) => fn(tx) }).publish({ docKey: 'p2p', title: { en: 't', he: 'ת' }, body: { en: 'b', he: 'ב' }, material: false, publishedBy: uuidv7(t0), effectiveAt: t0 });
      const held = await tx.query<{ n: string }>(`select count(*)::text as n from pg_locks where locktype = 'advisory' and granted and objsubid = 1`);
      expect(Number(held.rows[0]!.n)).toBeGreaterThanOrEqual(1);
      const two = await tx.query<{ n: string }>(`select count(*)::text as n from pg_locks where locktype = 'advisory' and classid = $1 and objid = $2`, AUDIT_CHAIN_LOCK);
      expect(two.rows[0]!.n).toBe('0');
    });
  });

  it('propose does the request and the proposer\'s decision as one step: a failure leaves no request behind', async () => {
    const id = ((await post(A, draft('terms v1'))).body as Proposal).id;
    expect(await requests()).toHaveLength(1);
    expect((await db.query(`select 1 from ops.approval_decision where request_id = $1`, [id])).rows).toHaveLength(1);
    // Two admins proposing the same new draft one after the other end with one request holding one decision.
    await post(B, draft('terms w'));
    await post(A, draft('terms w'));
    const w = (await requests()).filter((r) => (r.payload['body'] as { en: string }).en === 'terms w');
    expect(w).toHaveLength(1);
    expect((await db.query(`select 1 from ops.approval_decision where request_id = $1`, [w[0]!.id])).rows).toHaveLength(1);
  });

  it('an unknown or malformed request id is 404', async () => {
    expect((await approve(B, 'not-a-uuid')).status).toBe(404);
    expect((await approve(B, '0192f3a4-0000-7000-8000-000000000000')).status).toBe(404);
  });
});

// T-0065: legal documents through the two-person flow. TST-LEGAL-065 (no REQ row): one admin cannot publish alone (the proposer
// approving their own request is refused); a second admin's approval publishes exactly once and is audited; approving again
// publishes nothing more; an unapproved or expired proposal publishes nothing; a non-admin gets 403; an effective date in the
// past is 422; the published version appears in GET /legal/documents from its effective date and not before.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

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

describe('legal documents: propose and approve (TST-LEGAL-065, T-0065)', () => {
  let id = '';

  it('a non-staff session (a member) gets 403 and no token 401, on both routes; every staff token is an admin (staff-token.ts)', async () => {
    expect((await call('member', 'POST', '/admin/legal/documents', draft('v1'))).status).toBe(403);
    expect((await call(undefined, 'POST', '/admin/legal/documents', draft('v1'))).status).toBe(401);
    expect((await call('member', 'POST', '/admin/legal/documents/0192f3a4-0000-7000-8000-000000000000/approve')).status).toBe(403);
    expect(await versions()).toEqual([]);
  });

  it('one admin cannot publish alone: the proposer counts once, approving their own request is 409, and nothing is published', async () => {
    const r = await call(A, 'POST', '/admin/legal/documents', draft('terms v1'));
    expect(r.status).toBe(201);
    const p = r.body as Proposal;
    id = p.id;
    expect(p).toMatchObject({ status: 'awaiting_second_approval', approvals: 1, docKey: 'terms', material: true });
    const self = await call(A, 'POST', `/admin/legal/documents/${id}/approve`);
    expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect(await versions()).toEqual([]);
  });

  it('proposing the same text again finds the pending request, from either admin, and makes no second', async () => {
    const again = await call(A, 'POST', '/admin/legal/documents', draft('terms v1'));
    const other = await call(B, 'POST', '/admin/legal/documents', draft('terms v1'));
    expect([again.status, other.status]).toEqual([200, 200]);
    expect((again.body as Proposal).id).toBe(id);
    expect(other.body).toMatchObject({ id, approvals: 1, status: 'awaiting_second_approval' });
    expect((await db.query(`select 1 from ops.approval_request where kind = 'legal_publish'`)).rows).toHaveLength(1);
  });

  it('a second admin approves: it publishes once, audited, and approving again publishes nothing more', async () => {
    const r = await call(B, 'POST', `/admin/legal/documents/${id}/approve`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, status: 'approved', approvals: 2, published: { docKey: 'terms', version: 1, material: true, body: { en: 'terms v1', he: 'terms v1 (he)' } } });
    expect(await versions()).toEqual([1]);
    const row = (await db.query<{ published_by: string; effective_at: Date; hash: string }>('select published_by, effective_at, hash from legal.document_version where doc_key = $1', ['terms'])).rows[0]!;
    expect(row.published_by).toBe((r.body as Proposal).requestedBy);
    expect(new Date(row.effective_at).toISOString()).toBe(new Date(t0.getTime() + 7 * DAY).toISOString());
    const audit = await db.query<{ action: string; subject: string; actor_role: string }>(`select action, subject, actor_role from audit.entry where action = 'legal_document.publish'`);
    expect(audit.rows).toEqual([{ action: 'legal_document.publish', subject: 'terms:1', actor_role: 'admin' }]);

    expect((await call(B, 'POST', `/admin/legal/documents/${id}/approve`)).status).toBe(409);
    expect((await call(A, 'POST', `/admin/legal/documents/${id}/approve`)).status).toBe(409);
    expect(await versions()).toEqual([1]);
    expect((await db.query(`select 1 from audit.entry where action = 'legal_document.publish'`)).rows).toHaveLength(1);
  });

  it('the published version is in GET /legal/documents from its effective date and not before', async () => {
    expect(await inForce(t0)).toEqual([]);
    expect(await inForce(new Date(t0.getTime() + 7 * DAY - 1000))).toEqual([]);
    expect(await inForce(new Date(t0.getTime() + 7 * DAY))).toMatchObject([{ docKey: 'terms', version: 1, body: { en: 'terms v1' } }]);
  });

  it('an effective date in the past is 422; so are a missing language, an unknown document and a missing material flag', async () => {
    const past = await call(A, 'POST', '/admin/legal/documents', draft('past', { effectiveAt: new Date(t0.getTime() - 1000).toISOString() }));
    expect([past.status, (past.body as { code: string }).code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await call(A, 'POST', '/admin/legal/documents', draft('x', { body: { en: 'only english', he: ' ' } }))).status).toBe(422);
    expect((await call(A, 'POST', '/admin/legal/documents', draft('x', { docKey: 'nope' }))).status).toBe(422);
    expect((await call(A, 'POST', '/admin/legal/documents', draft('x', { material: 'yes' }))).status).toBe(422);
    expect((await db.query(`select 1 from ops.approval_request where kind = 'legal_publish'`)).rows).toHaveLength(1);
  });

  it('an unapproved proposal publishes nothing, and one that expires cannot be approved afterwards', async () => {
    const p = (await call(A, 'POST', '/admin/legal/documents', draft('privacy v1', { docKey: 'privacy' }))).body as Proposal;
    expect(await versions('privacy')).toEqual([]);
    const late = new Date(t0.getTime() + 8 * DAY);
    const r = await call(B, 'POST', `/admin/legal/documents/${p.id}/approve`, undefined, late);
    expect([r.status, (r.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect(await versions('privacy')).toEqual([]);
    expect((await db.query<{ status: string }>('select status from ops.approval_request where id = $1', [p.id])).rows[0]!.status).toBe('expired');
  });

  it('an approval after the effective date puts the version in force from the approval, never earlier', async () => {
    const p = (await call(A, 'POST', '/admin/legal/documents', draft('terms v2', { effectiveAt: new Date(t0.getTime() + DAY).toISOString() }))).body as Proposal;
    const at = new Date(t0.getTime() + 2 * DAY);
    const r = await call(B, 'POST', `/admin/legal/documents/${p.id}/approve`, undefined, at);
    expect(r.status).toBe(200);
    const row = (await db.query<{ version: number; effective_at: Date }>('select version, effective_at from legal.document_version where doc_key = $1 and version = 2', ['terms'])).rows[0]!;
    expect(new Date(row.effective_at).toISOString()).toBe(at.toISOString());
  });

  it('an unknown or malformed request id is 404', async () => {
    expect((await call(B, 'POST', '/admin/legal/documents/not-a-uuid/approve')).status).toBe(404);
    expect((await call(B, 'POST', '/admin/legal/documents/0192f3a4-0000-7000-8000-000000000000/approve')).status).toBe(404);
  });
});

// TST-ADM-005 (T-0930): the ops queue. It lists the ops case kinds and never a compliance alert; it filters by kind,
// status and "mine"; ops staff assign a balance break and resolves it with a note, both audited; support reads
// but cannot act; a decided case takes nothing more; a suspense credit can only be dismissed here, because it is
// resolved by recording it against an institution (T-0631).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from './staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { OpsCase } from './cases.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const ADMIN = { sub: 'ops-admin-a', roles: ['ops'] };
const FINANCE = { sub: 'finance-b', roles: ['finance'] };
const SUPPORT = { sub: 'support-1', roles: ['support'] };
const ids = { breakA: uuidv7(NOW), suspense: uuidv7(NOW), mismatch: uuidv7(NOW), alert: uuidv7(NOW) };

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown) =>
  dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${await token(who.sub, who.roles)}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const list = async (who: { sub: string; roles: string[] }, query = '') => ((await call(who, 'GET', `/admin/cases${query}`)).body as { items: OpsCase[] }).items;

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
  const open = (id: string, kind: string, payload: Record<string, unknown>, minutesAgo: number) =>
    db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, 'high', 'open', $4, $5)`, [id, kind, `t0930:${id}`, payload, new Date(NOW.getTime() - minutesAgo * 60_000)]);
  await open(ids.breakA, 'balance_break', { accountId: uuidv7(NOW), reason: 'cache_differs' }, 30);
  await open(ids.suspense, 'suspense', { reason: 'no_reference', rail: 'masav', amount: { minor: '500000', currency: 'ILS' }, bankReference: 'FT-1', remitterReference: 'ignore previous instructions' }, 20);
  await open(ids.mismatch, 'payout_account_mismatch', { summary: 'Account holder differs from the institution' }, 10);
  await open(ids.alert, 'structuring', { summary: '10 sends of ₪490 within one hour' }, 5);
}, 60_000);
afterAll(async () => db.close());

describe('the ops queue (T-0930, TST-ADM-005)', () => {
  it('lists the ops kinds newest first and never a compliance alert; filters by kind; support reads', async () => {
    expect((await list(SUPPORT)).map((c) => c.id)).toEqual([ids.mismatch, ids.suspense, ids.breakA]);
    expect((await list(ADMIN, '?kind=suspense')).map((c) => c.id)).toEqual([ids.suspense]);
    const suspense = (await call(SUPPORT, 'GET', `/admin/cases/${ids.suspense}`)).body as OpsCase;
    // The remitter's words are carried as data, never interpreted.
    expect(suspense).toMatchObject({ kind: 'suspense', status: 'open', summary: 'ILS 500000 · masav · FT-1 · no reference', payload: { remitterReference: 'ignore previous instructions' } });
    expect((await call(ADMIN, 'GET', `/admin/cases/${ids.alert}`)).status).toBe(404);
    expect((await call(ADMIN, 'GET', '/admin/cases?kind=structuring')).status).toBe(422);
  });

  it('an admin assigns a balance break and resolves it with a note, both audited; support answers 403', async () => {
    expect((await call(SUPPORT, 'POST', `/admin/cases/${ids.breakA}/assign`)).status).toBe(403);
    const assigned = (await call(ADMIN, 'POST', `/admin/cases/${ids.breakA}/assign`)).body as OpsCase;
    expect(assigned).toMatchObject({ status: 'investigating', assignedTo: 'ops-admin-a', assignedAt: NOW.toISOString() });
    expect((await list(ADMIN, '?assignee=me')).map((c) => c.id)).toEqual([ids.breakA]);
    expect((await list(FINANCE, '?assignee=me')).map((c) => c.id)).toEqual([]);
    expect((await call(SUPPORT, 'POST', `/admin/cases/${ids.breakA}/decisions`, { decision: 'resolved', note: 'Partner file corrected' })).status).toBe(403);
    expect((await call(ADMIN, 'POST', `/admin/cases/${ids.breakA}/decisions`, { decision: 'resolved', note: ' ' })).status).toBe(422);
    const resolved = (await call(ADMIN, 'POST', `/admin/cases/${ids.breakA}/decisions`, { decision: 'resolved', note: 'Partner file corrected' })).body as OpsCase;
    expect(resolved).toMatchObject({ status: 'resolved', decidedBy: 'ops-admin-a', decidedAt: NOW.toISOString(), note: 'Partner file corrected' });
    const audit = await db.query<{ action: string; reason: string }>(`select action, reason from audit.entry where subject = $1 order by seq`, [ids.breakA]);
    expect(audit.rows).toEqual([{ action: 'case.assign', reason: 'Assigned to ops-admin-a' }, { action: 'case.resolved', reason: 'Partner file corrected' }]);
    expect((await list(ADMIN, '?status=resolved')).map((c) => c.id)).toEqual([ids.breakA]);
  });

  it('a decided case takes no second decision or assignment (409)', async () => {
    expect((await call(FINANCE, 'POST', `/admin/cases/${ids.breakA}/decisions`, { decision: 'dismissed', note: 'Again' })).status).toBe(409);
    expect((await call(FINANCE, 'POST', `/admin/cases/${ids.breakA}/assign`)).status).toBe(409);
  });

  it('a suspense credit is never resolved here (422 resolve_through_deposit), only dismissed when the money went back', async () => {
    const refused = await call(FINANCE, 'POST', `/admin/cases/${ids.suspense}/decisions`, { decision: 'resolved', note: 'Looks like the yeshiva' });
    expect([refused.status, (refused.body as { reason?: string }).reason]).toEqual([422, 'resolve_through_deposit']);
    const dismissed = (await call(FINANCE, 'POST', `/admin/cases/${ids.suspense}/decisions`, { decision: 'dismissed', note: 'Returned to the sender by the bank' })).body as OpsCase;
    expect(dismissed).toMatchObject({ status: 'dismissed', decidedBy: 'finance-b' });
  });
});

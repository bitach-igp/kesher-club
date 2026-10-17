// Monitoring alerts through /admin/alerts (T-0908, REQ-CMP-001): ops.case rows of the monitoring
// kinds read as a queue, decided with a disposition and a note, audited per decision. The rules that
// open them are T-0909; here the rows are seeded the way the recon job and those rules write them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffPartyId } from './staff-token.ts';
import type { Alert } from './alerts.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-02T09:00:00Z');
const noa = uuidv7(new Date('2026-10-01T09:00:00Z'));
const ids = { structuring: uuidv7(NOW), velocity: uuidv7(NOW), recon: uuidv7(NOW), balance: uuidv7(NOW) };

const staffToken = async (sub: string, roles: string[] = ['ops']) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (method: string, url: string, body?: unknown, token?: string) =>
  dispatch(app, { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const seed = (id: string, kind: string, severity: string, payload: Record<string, unknown>, openedAt: string) =>
  db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, $4, 'open', $5, $6)`, [id, kind, `${kind}:${id}`, severity, JSON.stringify(payload), openedAt]);

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
  await seed(ids.velocity, 'velocity', 'medium', { partyId: noa, summary: '14 sends in 10 minutes' }, '2026-10-31T09:00:00Z');
  await seed(ids.structuring, 'structuring', 'high', { partyId: noa.toUpperCase(), summary: '10 sends of ₪490 within one hour to "Shlomo <script>"' }, '2026-10-31T11:00:00Z');
  await seed(ids.recon, 'recon_break', 'medium', { provider: 'simulator', externalId: 'ext-9', reason: 'missing_journal' }, '2026-10-30T06:00:00Z');
  // A balance break is an ops case but not an alert: the ledger proof owns it.
  await seed(ids.balance, 'balance_break', 'high', { accountId: uuidv7(NOW) }, '2026-10-29T06:00:00Z');
}, 60_000);
afterAll(async () => db.close());

describe('GET /admin/alerts', () => {
  it('lists only monitoring kinds, worst severity first then oldest, with the party and the summary as text', async () => {
    const r = await call('GET', '/v1/admin/alerts', undefined, await staffToken('ops-1'));
    expect(r.status).toBe(200);
    const items = (r.body as { items: Alert[] }).items;
    expect(items.map((a) => a.id)).toEqual([ids.structuring, ids.recon, ids.velocity]);
    expect(items[0]).toEqual({ id: ids.structuring, kind: 'structuring', severity: 'high', status: 'open', partyId: noa, summary: '10 sends of ₪490 within one hour to "Shlomo <script>"', openedAt: '2026-10-31T11:00:00.000Z' });
    expect(items[1]).toMatchObject({ kind: 'recon_break', summary: 'simulator · ext-9 · missing_journal' });
    expect(items[1]!.partyId).toBeUndefined();
  });

  it('needs a staff token', async () => {
    expect((await call('GET', '/v1/admin/alerts')).status).toBe(401);
  });
});

describe('POST /admin/alerts/{id}/decisions', () => {
  it('in_review keeps the alert open and can be decided again; cleared is final, resolves the case and is audited', async () => {
    const review = await call('POST', `/v1/admin/alerts/${ids.velocity}/decisions`, { decision: 'in_review', note: 'checking the counterparties' }, await staffToken('ops-1'));
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ status: 'in_review', decidedBy: 'ops-1', decidedAt: NOW.toISOString(), note: 'checking the counterparties' });
    expect((await db.query<{ status: string }>(`select status from ops.case where id = $1`, [ids.velocity])).rows[0]).toEqual({ status: 'investigating' });

    const cleared = await call('POST', `/v1/admin/alerts/${ids.velocity}/decisions`, { decision: 'cleared', note: 'tuition split across siblings' }, await staffToken('ops-2'));
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: 'cleared', decidedBy: 'ops-2', note: 'tuition split across siblings' });
    expect((await db.query<{ status: string; resolved_by: string; resolution: string }>(`select status, resolved_by, resolution from ops.case where id = $1`, [ids.velocity])).rows[0]).toEqual({ status: 'resolved', resolved_by: staffPartyId('ops-2'), resolution: 'tuition split across siblings' });
    expect((await call('POST', `/v1/admin/alerts/${ids.velocity}/decisions`, { decision: 'in_review', note: 'again' }, await staffToken('ops-3'))).status).toBe(409);

    const audit = (await call('GET', `/v1/admin/audit?subject=${ids.velocity}`, undefined, await staffToken('ops-1'))).body as { items: { action: string; actorId: string; reason: string; payload: Record<string, unknown> }[] };
    expect(audit.items.map((e) => [e.action, e.actorId])).toEqual([
      ['alert.cleared', staffPartyId('ops-2')],
      ['alert.in_review', staffPartyId('ops-1')],
    ]);
    expect(audit.items[0]).toMatchObject({ reason: 'tuition split across siblings', payload: { kind: 'velocity', partyId: noa } });
  });

  it('escalated is final too, and the queue shows decided alerts after the open ones', async () => {
    const r = await call('POST', `/v1/admin/alerts/${ids.recon}/decisions`, { decision: 'escalated', note: 'partner file missing a day' }, await staffToken('ops-1'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'escalated' });
    expect((await call('POST', `/v1/admin/alerts/${ids.recon}/decisions`, { decision: 'cleared', note: 'x' }, await staffToken('ops-1'))).status).toBe(409);
    const items = ((await call('GET', '/v1/admin/alerts', undefined, await staffToken('ops-1'))).body as { items: Alert[] }).items;
    expect(items[0]).toMatchObject({ id: ids.structuring, status: 'open' });
    // Both were decided at the same instant; the queue only promises the undecided one comes first.
    expect(new Map(items.slice(1).map((a) => [a.id, a.status]))).toEqual(new Map([[ids.recon, 'escalated'], [ids.velocity, 'cleared']]));
  });

  it('validates the decision and the note, and 404s for a case that is not an alert', async () => {
    const t = await staffToken('ops-1');
    expect((await call('POST', `/v1/admin/alerts/${ids.structuring}/decisions`, { decision: 'ignore', note: 'x' }, t)).status).toBe(422);
    expect((await call('POST', `/v1/admin/alerts/${ids.structuring}/decisions`, { decision: 'cleared', note: '  ' }, t)).status).toBe(422);
    expect((await call('POST', `/v1/admin/alerts/${ids.structuring}/decisions`, { decision: 'cleared' }, t)).status).toBe(422);
    expect((await call('POST', `/v1/admin/alerts/${ids.balance}/decisions`, { decision: 'cleared', note: 'x' }, t)).status).toBe(404);
    expect((await call('POST', `/v1/admin/alerts/not-a-uuid/decisions`, { decision: 'cleared', note: 'x' }, t)).status).toBe(404);
    // Nothing above touched the structuring alert.
    expect(((await call('GET', '/v1/admin/alerts', undefined, t)).body as { items: Alert[] }).items[0]).toMatchObject({ id: ids.structuring, status: 'open' });
  });
});

// TST-WAL-003 (T-0788): staff resolving a failed-owner case (`subaccount_owner_failed`, dedupe `subaccount-owner:{party}`) clears that party's
// `subaccount_owner:{provider}` marker in the SAME transaction as the decision; dismissing does not; no other case kind touches a marker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import type { AuditService } from '../audit/service.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER } from './staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { openCase } from '../ops/cases.ts';
import { getMarker, putMarker } from '../ops/workflow-marker.ts';
import { ownerFailedMarker } from '../wallet/sub-account-markers.ts';
import { OWNER_FAILED_CASE, ownerCaseKey, ownerKind } from '../wallet/sub-accounts.ts';
import { OpsCases, type CaseActor, type OpsCase } from './cases.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-23T09:00:00Z');
const OPS = { sub: 'ops-admin-a', roles: ['ops'] };
const SUPPORT = { sub: 'support-1', roles: ['support'] };
const PROVIDER = new SimulatorHost().registry.bindingFor('funding', 'IL')?.provider ?? 'simulator';
const ACTOR: CaseActor = { subject: 'ops-admin-a', partyId: uuidv7(NOW), role: 'ops' };

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown) =>
  dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${await token(who.sub, who.roles)}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
}, 120_000);
afterAll(async () => db.close());

/** A failed owner: the marker and its open case, as `SubAccountService.open` leaves them. */
async function failedOwner(provider = PROVIDER) {
  const party = uuidv7(NOW);
  await putMarker(db, { kind: ownerKind(provider), subjectId: party, value: ownerFailedMarker(party) });
  await openCase(db, { kind: OWNER_FAILED_CASE, dedupeKey: ownerCaseKey(party), severity: 'medium', payload: { partyId: party }, now: NOW });
  const id = (await db.query<{ id: string }>(`select id from ops.case where dedupe_key = $1`, [ownerCaseKey(party)])).rows[0]!.id;
  return { party, id };
}
const marker = (party: string, provider = PROVIDER) => getMarker(db, ownerKind(provider), party);
const decide = (id: string, decision: 'resolved' | 'dismissed', who = OPS) => call(who, 'POST', `/admin/cases/${id}/decisions`, { decision, note: 'Owner re-invited at the vendor' });
const status = async (id: string) => (await db.query<{ status: string }>(`select status from ops.case where id = $1`, [id])).rows[0]!.status;

describe('resolving a failed-owner case clears the marker (T-0788)', () => {
  it('the owner case is in the queue: listed, readable, filterable by its kind', async () => {
    const { id } = await failedOwner();
    const got = (await call(SUPPORT, 'GET', `/admin/cases/${id}`)).body as OpsCase;
    expect(got).toMatchObject({ id, kind: 'subaccount_owner_failed', status: 'open', severity: 'medium' });
    const listed = ((await call(SUPPORT, 'GET', '/admin/cases?kind=subaccount_owner_failed')).body as { items: OpsCase[] }).items;
    expect(listed.map((c) => c.id)).toContain(id);
  });

  it('resolved: the marker is gone, the case is resolved, and the audit line says the marker was cleared', async () => {
    const { party, id } = await failedOwner();
    expect(await marker(party)).toBe(ownerFailedMarker(party));
    const r = await decide(id, 'resolved');
    expect(r.status).toBe(200);
    expect(await marker(party)).toBeUndefined();
    expect(await status(id)).toBe('resolved');
    const audit = await db.query<{ payload: Record<string, unknown> }>(`select payload from audit.entry where subject = $1 and action = 'case.resolved'`, [id]);
    expect(audit.rows[0]!.payload).toMatchObject({ kind: OWNER_FAILED_CASE, markerCleared: true });
  });

  it('dismissed: the marker STAYS (credits stay blocked), the case is dismissed, the audit line carries no markerCleared', async () => {
    const { party, id } = await failedOwner();
    expect((await decide(id, 'dismissed')).status).toBe(200);
    expect(await marker(party)).toBe(ownerFailedMarker(party));
    expect(await status(id)).toBe('dismissed');
    const audit = await db.query<{ payload: Record<string, unknown> }>(`select payload from audit.entry where subject = $1 and action = 'case.dismissed'`, [id]);
    expect(audit.rows[0]!.payload).toEqual({ kind: OWNER_FAILED_CASE });
  });

  it('support may not decide: 403, the marker stays and the case is untouched', async () => {
    const { party, id } = await failedOwner();
    expect((await decide(id, 'resolved', SUPPORT)).status).toBe(403);
    expect(await marker(party)).toBe(ownerFailedMarker(party));
    expect(await status(id)).toBe('open');
  });

  it('a replayed resolve is refused (409) and changes nothing more; a marker written again later is not cleared by it', async () => {
    const { party, id } = await failedOwner();
    expect((await decide(id, 'resolved')).status).toBe(200);
    await putMarker(db, { kind: ownerKind(PROVIDER), subjectId: party, value: ownerFailedMarker(party) });
    expect((await decide(id, 'resolved')).status).toBe(409);
    expect(await marker(party)).toBe(ownerFailedMarker(party));
  });

  it('a resolve with no marker present (already cleared) still succeeds: the clear is a no-op', async () => {
    const { party, id } = await failedOwner();
    await db.query(`delete from ops.workflow_marker where kind = $1 and subject_id = $2`, [ownerKind(PROVIDER), party]);
    expect((await decide(id, 'resolved')).status).toBe(200);
    const audit = await db.query<{ payload: Record<string, unknown> }>(`select payload from audit.entry where subject = $1 and action = 'case.resolved'`, [id]);
    expect(audit.rows[0]!.payload).toMatchObject({ markerCleared: false });
  });

  it('clears only this party under this provider: another party, and the same party under another provider, keep theirs', async () => {
    const a = await failedOwner();
    const b = await failedOwner();
    await putMarker(db, { kind: ownerKind('other-provider'), subjectId: a.party, value: ownerFailedMarker(a.party) });
    expect((await decide(a.id, 'resolved')).status).toBe(200);
    expect(await marker(a.party)).toBeUndefined();
    expect(await marker(a.party, 'other-provider')).toBe(ownerFailedMarker(a.party));
    expect(await marker(b.party)).toBe(ownerFailedMarker(b.party));
    expect(await status(b.id)).toBe('open');
  });

  it('only the owner case kind clears: resolving or dismissing any other kind that names the same party never touches the marker', async () => {
    const { party } = await failedOwner();
    for (const [kind, decision] of [['balance_break', 'resolved'], ['balance_break', 'dismissed'], ['kyb_application', 'resolved'], ['payout_account_mismatch', 'resolved']] as const) {
      const id = uuidv7(NOW);
      await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, 'high', 'open', $4, $5)`, [id, kind, `t0788:${id}`, { partyId: party, summary: 'x' }, NOW]);
      expect((await decide(id, decision)).status).toBe(200);
      expect(await marker(party), `${kind} ${decision}`).toBe(ownerFailedMarker(party));
    }
  });

  it('a payload with no usable party id clears nothing and the decision still stands', async () => {
    for (const payload of [{}, { partyId: 42 }, { partyId: '' }]) {
      const id = uuidv7(NOW);
      await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, 'medium', 'open', $4, $5)`, [id, OWNER_FAILED_CASE, `t0788:${id}`, payload, NOW]);
      expect((await decide(id, 'resolved')).status).toBe(200);
    }
  });

  it('with no provider configured on OpsCases nothing is cleared (the decision still stands)', async () => {
    const { party, id } = await failedOwner();
    const bare = new OpsCases(db, app.services.audit);
    expect((await bare.decide(id, 'resolved', 'done', ACTOR, NOW)).status).toBe('resolved');
    expect(await marker(party)).toBe(ownerFailedMarker(party));
  });

  it('is atomic: when the audit write fails the case stays open AND the marker stays', async () => {
    const { party, id } = await failedOwner();
    const failing = { record: async () => { throw new Error('audit down'); } } as unknown as AuditService;
    await expect(new OpsCases(db, failing, PROVIDER).decide(id, 'resolved', 'done', ACTOR, NOW)).rejects.toThrow('audit down');
    expect(await status(id)).toBe('open');
    expect(await marker(party)).toBe(ownerFailedMarker(party));
  });

  it('is atomic the other way: when the marker delete fails the case stays open', async () => {
    const { party, id } = await failedOwner();
    // The transaction hands its own client to the callback, so break the delete there through a wrapping Database.
    const wrapped = { query: db.query.bind(db), transaction: async <T,>(fn: (tx: never) => Promise<T>) => db.transaction(async (tx) => fn({ query: (t: string, p?: readonly unknown[]) => (t.startsWith('delete from ops.workflow_marker') ? Promise.reject(new Error('delete down')) : tx.query(t, p)) } as never)) } as unknown as typeof db;
    await expect(new OpsCases(wrapped, app.services.audit, PROVIDER).decide(id, 'resolved', 'done', ACTOR, NOW)).rejects.toThrow('delete down');
    expect(await status(id)).toBe('open');
    expect(await marker(party)).toBe(ownerFailedMarker(party));
  });
});

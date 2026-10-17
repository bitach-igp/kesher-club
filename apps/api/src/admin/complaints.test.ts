// Complaints through /admin/complaints (T-0908, REQ-CMP-002), end to end over the dispatcher and
// PGlite. TST-CMP-002: acknowledge and resolve stamp the acting staff subject and the API clock, the
// SLA clocks run from openedAt (which a back-dated log keeps honest), and the export rows are the table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffPartyId } from './staff-token.ts';
import type { Complaint } from './complaints.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-02T09:00:00Z'); // a Monday
const noa = uuidv7(new Date('2026-10-01T09:00:00Z'));

const staffToken = async (sub: string, roles: string[] = ['ops']) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (method: string, url: string, body?: unknown, token?: string, now = NOW) =>
  dispatch(app, { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const log = async (sub: string, body: Record<string, unknown>) => call('POST', '/v1/admin/complaints', { partyId: noa, channel: 'phone', category: 'card_decline', summary: 'Card declined at pharmacy twice', ...body }, await staffToken(sub));

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
}, 60_000);
afterAll(async () => db.close());

describe('logging a complaint', () => {
  it('stamps who logged it, keeps the member text as text, and back-dates openedAt when told to', async () => {
    const r = await log('ops-1', { summary: '=HYPERLINK("x") <b>declined</b> twice', openedAt: '2026-10-28T10:00:00Z', escalatedToBank: true });
    expect(r.status).toBe(201);
    const c = r.body as Complaint;
    expect(c).toMatchObject({ partyId: noa, channel: 'phone', category: 'card_decline', summary: '=HYPERLINK("x") <b>declined</b> twice', status: 'open', openedAt: '2026-10-28T10:00:00.000Z', loggedBy: 'ops-1', escalatedToBank: true });
    expect(c.acknowledgedAt).toBeUndefined();
    const audit = await call('GET', `/v1/admin/audit?subject=${noa}`, undefined, await staffToken('ops-1'));
    const entries = (audit.body as { items: { action: string; actorId: string; payload: Record<string, unknown> }[] }).items;
    expect(entries[0]).toMatchObject({ action: 'complaint.opened', actorId: staffPartyId('ops-1'), payload: { complaintId: c.id, channel: 'phone' } });
    // The member's text never enters the audit chain.
    expect(JSON.stringify(entries)).not.toContain('HYPERLINK');
  });

  it('validates the body and refuses a future openedAt', async () => {
    expect((await log('ops-1', { channel: 'carrier pigeon' })).status).toBe(422);
    expect((await log('ops-1', { summary: '   ' })).status).toBe(422);
    expect((await log('ops-1', { partyId: 'noa' })).status).toBe(422);
    expect((await log('ops-1', { openedAt: '2026-12-01T00:00:00Z' })).status).toBe(422);
    expect((await log('ops-1', { openedAt: 'yesterday-ish' })).status).toBe(422);
    expect((await call('POST', '/v1/admin/complaints', {}, await staffToken('ops-1'))).status).toBe(422);
  });

  it('needs a staff token', async () => {
    expect((await call('GET', '/v1/admin/complaints')).status).toBe(401);
    const member = await app.services.tokens.issue({ partyId: noa, roles: ['member'], deviceId: 'd1' });
    expect((await call('GET', '/v1/admin/complaints', undefined, member.accessToken)).status).toBe(403);
  });
});

describe('acknowledge and resolve (TST-CMP-002)', () => {
  it('stamp the staff subject and the API clock, and only move forward', async () => {
    const c = (await log('ops-1', {})).body as Complaint;
    const ackAt = new Date('2026-11-03T08:00:00Z');
    const ack = await call('POST', `/v1/admin/complaints/${c.id}/acknowledge`, undefined, await staffToken('ops-2'), ackAt);
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged', acknowledgedAt: ackAt.toISOString(), acknowledgedBy: 'ops-2', owner: 'ops-2' });
    // Acknowledging twice is a conflict, not a second stamp.
    expect((await call('POST', `/v1/admin/complaints/${c.id}/acknowledge`, undefined, await staffToken('ops-3'), ackAt)).status).toBe(409);
    const resolveAt = new Date('2026-11-10T15:30:00Z');
    const res = await call('POST', `/v1/admin/complaints/${c.id}/resolve`, undefined, await staffToken('ops-3'), resolveAt);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', resolvedAt: resolveAt.toISOString(), resolvedBy: 'ops-3', acknowledgedBy: 'ops-2', owner: 'ops-2' });
    expect((await call('POST', `/v1/admin/complaints/${c.id}/resolve`, undefined, await staffToken('ops-3'), resolveAt)).status).toBe(409);
    expect((await call('POST', `/v1/admin/complaints/${uuidv7(NOW)}/resolve`, undefined, await staffToken('ops-3'))).status).toBe(404);
    const audit = (await call('GET', `/v1/admin/audit?subject=${noa}`, undefined, await staffToken('ops-1'))).body as { items: { action: string; actorId: string }[] };
    expect(audit.items.slice(0, 2)).toEqual([expect.objectContaining({ action: 'complaint.resolved', actorId: staffPartyId('ops-3') }), expect.objectContaining({ action: 'complaint.acknowledged', actorId: staffPartyId('ops-2') })]);
  });

  it('resolving an open complaint acknowledges it in the same stroke with the same stamps', async () => {
    const c = (await log('ops-1', {})).body as Complaint;
    const at = new Date('2026-11-04T12:00:00Z');
    const res = (await call('POST', `/v1/admin/complaints/${c.id}/resolve`, undefined, await staffToken('ops-9'), at)).body as Complaint;
    expect(res).toMatchObject({ status: 'resolved', acknowledgedAt: at.toISOString(), acknowledgedBy: 'ops-9', resolvedAt: at.toISOString(), resolvedBy: 'ops-9', owner: 'ops-9' });
  });
});

describe('the list is the export', () => {
  it('returns every row with the stamps the table holds, open ones first by age', async () => {
    const r = await call('GET', '/v1/admin/complaints', undefined, await staffToken('ops-1'));
    expect(r.status).toBe(200);
    const items = (r.body as { items: Complaint[] }).items;
    const rows = (await db.query<{ id: string; status: string; opened_at: Date; acknowledged_at: Date | null; acknowledged_by: string | null; resolved_at: Date | null; resolved_by: string | null; owner: string | null; logged_by: string; escalated_to_bank: boolean }>(`select * from ops.complaint`)).rows;
    expect(items).toHaveLength(rows.length);
    for (const row of rows) {
      const item = items.find((i) => i.id === row.id)!;
      expect(item).toMatchObject({ status: row.status, openedAt: new Date(row.opened_at).toISOString(), loggedBy: row.logged_by, escalatedToBank: row.escalated_to_bank });
      expect(item.acknowledgedAt).toBe(row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : undefined);
      expect(item.acknowledgedBy).toBe(row.acknowledged_by ?? undefined);
      expect(item.resolvedAt).toBe(row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined);
      expect(item.resolvedBy).toBe(row.resolved_by ?? undefined);
      expect(item.owner).toBe(row.owner ?? undefined);
    }
    const open = items.filter((i) => i.status === 'open' || i.status === 'acknowledged');
    expect(items.slice(0, open.length)).toEqual(open);
    expect(open.map((i) => i.openedAt)).toEqual([...open.map((i) => i.openedAt)].sort());
  });
});

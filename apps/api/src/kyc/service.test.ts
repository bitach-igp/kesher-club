// KYC sessions and tiers (T-0401) end to end: start T1/T2 over /kyc/sessions, decisions through the
// provider webhook (deduped by event id, forged signatures refused), the tier gate the card programme
// uses, and the rule that no image, document or capture token is ever stored.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { KycError, type KycPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { KycService } from './service.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-01T09:00:00Z');
const noa = uuidv7(NOW);
const dana = uuidv7(NOW);
let noaToken = '';
let danaToken = '';

const call = async (method: string, url: string, body?: unknown, token?: string, headers: Record<string, string> = {}, now = NOW) =>
  dispatch(app, { method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const start = (token: string, tier: string, key: string, now = NOW) => call('POST', '/v1/kyc/sessions', { tier }, token, { 'idempotency-key': key }, now);
const status = async (token: string) => (await call('GET', '/v1/kyc/status', undefined, token)).body as { status: string; approvedTier?: string; current?: { sessionId: string; status: string; reasons: string[] } };
const webhook = (body: unknown, signature = 'sim') => call('POST', '/v1/hooks/kyc', body, undefined, { 'x-sim-signature': signature });

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  noaToken = (await app.services.tokens.issue({ partyId: noa, roles: ['member'], deviceId: 'd1' })).accessToken;
  danaToken = (await app.services.tokens.issue({ partyId: dana, roles: ['member'], deviceId: 'd2' })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('POST /kyc/sessions', () => {
  it('starts a T2 session once per idempotency key and hands the client token out exactly once', async () => {
    expect((await call('GET', '/v1/kyc/status', undefined, noaToken)).body).toEqual({ status: 'none' });
    const r = await start(noaToken, 'T2', 'kyc-noa-1');
    expect(r.status).toBe(201);
    const s = r.body as { sessionId: string; clientToken: string; tier: string; status: string; expiresAt: string };
    expect(s).toMatchObject({ tier: 'T2', status: 'pending', reasons: [], startedAt: NOW.toISOString() });
    expect(s.clientToken).toMatch(/^ct_/);
    const again = (await start(noaToken, 'T2', 'kyc-noa-1')).body as { sessionId: string };
    expect(again.sessionId).toBe(s.sessionId);
    const st = await status(noaToken);
    expect(st).toMatchObject({ status: 'pending', current: { sessionId: s.sessionId, status: 'pending' } });
    expect(st.approvedTier).toBeUndefined();
    expect(JSON.stringify(st)).not.toContain('ct_');
    // Nothing but the provider reference and the decision is stored: no token, no images, no document data.
    const row = await db.query(`select * from identity.kyc_session where session_id = $1`, [s.sessionId]);
    expect(row.rows).toHaveLength(1);
    expect(Object.keys(row.rows[0]!).sort()).toEqual(['decided_at', 'expires_at', 'last_event_id', 'market', 'party_id', 'provider', 'reasons', 'session_id', 'started_at', 'status', 'tier', 'updated_at']);
    expect(JSON.stringify(row.rows)).not.toContain(s.clientToken);
  });

  it('validates the tier and needs a member token and an idempotency key', async () => {
    expect((await start(noaToken, 'T3', 'kyc-noa-bad')).status).toBe(422);
    expect((await call('POST', '/v1/kyc/sessions', { tier: 'T1' }, noaToken)).status).toBe(422);
    expect((await start('', 'T1', 'kyc-anon')).status).toBe(401);
  });
});

describe('decisions through /hooks/kyc', () => {
  it('a forged signature is refused and changes nothing; a verified approval flips the status and the tier gate', async () => {
    const { current } = await status(noaToken);
    const forged = await webhook({ eventId: 'evt-forged', sessionId: current!.sessionId, status: 'approved' }, 'nope');
    expect(forged.status).toBe(401);
    expect((await status(noaToken)).status).toBe('pending');
    await expect(app.services.kyc.requireApproved(noa, 'T1')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const ok = await webhook({ eventId: 'evt-1', sessionId: current!.sessionId, status: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ eventId: 'evt-1', duplicate: false });
    const st = await status(noaToken);
    expect(st).toMatchObject({ status: 'approved', approvedTier: 'T2', current: { status: 'approved', reasons: [] } });
    expect(st.current).toHaveProperty('decidedAt', NOW.toISOString());
    await expect(app.services.kyc.requireApproved(noa, 'T1')).resolves.toBeUndefined();
    await expect(app.services.kyc.requireApproved(noa, 'T2')).resolves.toBeUndefined();
    expect(await app.services.kyc.isApproved(noa, 'T2')).toBe(true);
  });

  it('the same event id delivered twice is a duplicate and applies once', async () => {
    const { current } = await status(noaToken);
    const dup = await webhook({ eventId: 'evt-1', sessionId: current!.sessionId, status: 'rejected' });
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ eventId: 'evt-1', duplicate: true });
    expect((await status(noaToken)).status).toBe('approved');
    // The forged attempt and evt-1 are stored once each; the replay is the same (provider, event id) row.
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.inbound_event where provider = 'kyc'`)).rows[0]!.n).toBe(2);
  });

  it('an approved tier cannot be started again, and a lower tier is covered by the higher one', async () => {
    expect((await start(noaToken, 'T2', 'kyc-noa-2')).status).toBe(422);
    expect((await start(noaToken, 'T1', 'kyc-noa-3')).status).toBe(422);
  });

  it('a rejection carries the provider reasons, gates features off, and the member can start afresh', async () => {
    const s = (await start(danaToken, 'T1', 'kyc-dana-1')).body as { sessionId: string };
    expect((await webhook({ eventId: 'evt-2', sessionId: s.sessionId, status: 'rejected' })).status).toBe(200);
    const st = await status(danaToken);
    expect(st).toMatchObject({ status: 'rejected', current: { reasons: ['DOCUMENT_MISMATCH'] } });
    expect(st.approvedTier).toBeUndefined();
    await expect(app.services.kyc.requireApproved(dana, 'T1')).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Identity verification (T1) is required' });
    const retry = await start(danaToken, 'T1', 'kyc-dana-2', new Date(NOW.getTime() + 60_000));
    expect(retry.status).toBe(201);
    expect((retry.body as { sessionId: string }).sessionId).not.toBe(s.sessionId);
    expect((await status(danaToken)).status).toBe('pending');
    await expect(app.services.kyc.requireApproved(dana, 'T1')).rejects.toMatchObject({ message: 'Identity verification (T1) is still pending' });
    // A review decision is neither approved nor final.
    const cur = (await status(danaToken)).current!;
    await webhook({ eventId: 'evt-3', sessionId: cur.sessionId, status: 'review' });
    expect(await status(danaToken)).toMatchObject({ status: 'review', current: { reasons: ['MANUAL_REVIEW'] } });
    expect(await app.services.kyc.isApproved(dana, 'T1')).toBe(false);
  });

  it('a decision for a session we never opened is refused and recorded', async () => {
    const r = await webhook({ eventId: 'evt-ghost', sessionId: 'kyc_999', status: 'approved' });
    expect(r.status).toBe(401);
    const stored = await db.query<{ signature_ok: boolean }>(`select signature_ok from ops.inbound_event where provider = 'kyc' and event_id = 'evt-ghost'`);
    expect(stored.rows[0]).toEqual({ signature_ok: false });
  });
});

describe('provider outage', () => {
  it('surfaces as PROVIDER_UNAVAILABLE and leaves no session behind', async () => {
    const down: KycPort = {
      start: async () => {
        throw new KycError('PROVIDER_UNAVAILABLE', 'down');
      },
      getDecision: async () => {
        throw new KycError('UNKNOWN_SESSION', 'x');
      },
      parseWebhook: async () => {
        throw new KycError('BAD_SIGNATURE', 'x');
      },
    };
    const svc = new KycService(db, down, 'IL');
    const party = uuidv7(NOW);
    await expect(svc.start(party, 'T1', 'kyc-down-1', NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await svc.status(party)).toEqual({ status: 'none' });
  });
});

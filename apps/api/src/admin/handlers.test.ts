// /admin/* end to end over the HTTP dispatcher and PGlite (T-0906, ADR-013).
// TST-ADM-002: a flag flip needs two distinct admins and is audited; TST-ADM-001: the audit chain
// is readable and verifiable through the API. Member tokens are refused on every admin route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { loadRegistry, StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffPartyId } from './staff-token.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-01T09:00:00Z');
const staffToken = (sub: string, roles: string[] = ['ops']) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (method: string, url: string, body?: unknown, token?: string) =>
  dispatch(app, { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
}, 60_000);
afterAll(async () => db.close());

describe('/admin/* access', () => {
  it('401s without a token and serves a staff token', async () => {
    expect((await call('GET', '/v1/admin/flags')).status).toBe(401);
    const r = await call('GET', '/v1/admin/bindings', undefined, await staffToken('zvi'));
    expect(r.status).toBe(200);
    const items = (r.body as { items: { capability: string; provider?: string; mode?: string; market: string }[] }).items;
    expect(items).toHaveLength(20);
    expect(items.find((b) => b.capability === 'billing')).toMatchObject({ provider: 'simulator', mode: 'sim', market: 'IL' });
  });

  it('a staff token on a member route is FORBIDDEN, never a 500', async () => {
    const me = await call('GET', '/v1/accounts', undefined, await staffToken('zvi'));
    expect(me.status).toBe(403);
    expect((me.body as { code: string }).code).toBe('FORBIDDEN');
  });
});

describe('stored flags beside injected evaluation flags (T-0919)', () => {
  it('lists the stored flags, not the in-memory ones, when the app evaluates with StaticFlags (the demo process)', async () => {
    const allOn = new StaticFlags(undefined, Object.fromEntries(loadRegistry().map((f) => [f.key, true])));
    const pair = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-2', alg: 'ES256', use: 'sig' };
    const demo = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW, flags: allOn });
    const token = await new SignJWT({ roles: ['admin'] }).setProtectedHeader({ alg: 'ES256', kid: 'admin-2' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject('ada').setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(pair.privateKey);
    const r = await dispatch(demo, { method: 'GET', url: '/v1/admin/flags', headers: { authorization: `Bearer ${token}` }, rawBody: '', now: NOW });
    expect(r.status).toBe(200);
    expect((r.body as { items: { key: string; value: boolean }[] }).items.find((f) => f.key === 'wallet.enabled')).toMatchObject({ value: false });
    expect(await demo.services.flags.isOn('wallet.enabled')).toBe(true);
  });
});

describe('flag flips through the API (TST-ADM-002) and the audit chain (TST-ADM-001)', () => {
  it('lists flags with registry defaults, proposes a flip, needs a second distinct admin, then applies and audits it', async () => {
    const a = await staffToken('ops-1');
    const b = await staffToken('ops-2');
    const list = await call('GET', '/v1/admin/flags', undefined, a);
    expect(list.status).toBe(200);
    const flags = (list.body as { items: { key: string; value: boolean; money: boolean }[] }).items;
    expect(flags.find((f) => f.key === 'esim.airalo')).toMatchObject({ value: false, money: false });
    expect(flags.find((f) => f.key === 'wallet.enabled')).toMatchObject({ value: false, money: true });

    const bad = await call('POST', '/v1/admin/flags/esim.airalo/flips', { to: true }, a);
    expect(bad.status).toBe(422);
    const proposed = await call('POST', '/v1/admin/flags/esim.airalo/flips', { to: true, reason: 'Airalo sandbox certified' }, a);
    expect(proposed.status).toBe(201);
    const req = proposed.body as { id: string; status: string; approvals: number };
    expect(req).toMatchObject({ status: 'awaiting_second_approval', approvals: 1 });
    // Not flipped yet, and the pending flip shows on the list.
    const mid = (await call('GET', '/v1/admin/flags', undefined, b)).body as { items: { key: string; value: boolean; pendingFlip?: { id: string } }[] };
    expect(mid.items.find((f) => f.key === 'esim.airalo')).toMatchObject({ value: false, pendingFlip: { id: req.id } });
    // The proposer cannot be the second approver.
    const same = await call('POST', `/v1/admin/flag-flips/${req.id}/approve`, undefined, a);
    expect(same.status).toBeGreaterThanOrEqual(400);
    const second = await call('POST', `/v1/admin/flag-flips/${req.id}/approve`, undefined, b);
    expect(second.status).toBe(200);
    expect((second.body as { status: string }).status).toBe('approved');
    const after = (await call('GET', '/v1/admin/flags', undefined, a)).body as { items: { key: string; value: boolean; changedAt?: string }[] };
    expect(after.items.find((f) => f.key === 'esim.airalo')).toMatchObject({ value: true });
    const audit = await call('GET', '/v1/admin/audit?subject=esim.airalo', undefined, a);
    expect(audit.status).toBe(200);
    const entries = (audit.body as { items: { action: string; actorId: string; hash: string; prevHash: string }[] }).items;
    expect(entries[0]).toMatchObject({ action: 'flag.flip', actorId: staffPartyId('ops-2') });
    const verify = await call('POST', '/v1/admin/audit/verify', undefined, a);
    expect(verify.body).toMatchObject({ ok: true });
    const unknown = await call('POST', '/v1/admin/flags/not.a.flag/flips', { to: true, reason: 'x' }, a);
    expect(unknown.status).toBe(404);
  });
});

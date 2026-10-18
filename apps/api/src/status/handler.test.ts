// GET /status (T-0911, CLUB-39) over the HTTP dispatcher and PGlite: public, one state per money
// capability from the flags and the provider bindings, and the incident an admin attached to a
// two-person kill-switch flip. No secrets and no provider names in the body.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { PORTS } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { serviceStatus } from './handler.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
let privateKey: CryptoKey;
let now = new Date('2026-11-01T09:00:00Z');
const staffToken = (sub: string) =>
  new SignJWT({ roles: ['ops'] }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(now.getTime() / 1000)).setExpirationTime(Math.floor(now.getTime() / 1000) + 300).sign(privateKey);
const call = (method: string, url: string, body?: unknown, token?: string) => dispatch(app, { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const status = () => call('GET', '/v1/status');

/** Two distinct admins flip a flag; the proposal may carry an incident. */
async function flip(key: string, to: boolean, incident?: unknown) {
  const proposed = await call('POST', `/v1/admin/flags/${key}/flips`, { to, reason: `test ${key} ${to}`, ...(incident ? { incident } : {}) }, await staffToken('admin-1'));
  if (proposed.status !== 201) return proposed;
  return call('POST', `/v1/admin/flag-flips/${(proposed.body as { id: string }).id}/approve`, undefined, await staffToken('admin-2'));
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => now });
}, 60_000);
afterAll(async () => db.close());

describe('GET /status (T-0911)', () => {
  it('needs no bearer and answers each money capability off while its flag is off, ok once a flip turns it on', async () => {
    const first = await status();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ capabilities: { wallet: 'off', card: 'off', p2p: 'off', fx: 'off', payouts: 'off' } });
    expect((await flip('p2p.enabled', true)).status).toBe(200);
    expect((await status()).body).toMatchObject({ capabilities: { p2p: 'ok', wallet: 'off' } });
  });

  it('a kill switch with an incident is degraded with the incident copy; switching back on clears it', async () => {
    expect((await flip('wallet.enabled', true)).status).toBe(200);
    expect((await status()).body).toMatchObject({ capabilities: { wallet: 'ok' } });
    now = new Date('2026-11-01T10:30:00Z');
    const incident = { title: 'Card top-ups are delayed', body: 'Your money is safe. Top-ups will land as soon as our partner is back. https://not-a-link.example stays text.' };
    expect((await flip('wallet.enabled', false, incident)).status).toBe(200);
    const r = await status();
    expect(r.body).toEqual({ capabilities: { wallet: 'degraded', card: 'off', p2p: 'ok', fx: 'off', payouts: 'off' }, incident: { ...incident, since: now.toISOString() } });

    // No provider, binding mode or vendor name reaches the public body.
    const text = JSON.stringify(r.body).toLowerCase();
    const vendors = [...new Set(PORTS.flatMap((p) => p.vendors))].filter((v) => !incident.body.toLowerCase().includes(v));
    for (const name of [...vendors, 'simulator', 'sandbox', 'live']) expect(text).not.toContain(`"${name}"`);
    for (const name of vendors) expect(text.replace(incident.body.toLowerCase(), '')).not.toContain(name);

    // Back on the same day: one admin's proposal changes nothing; the second admin's approval does.
    now = new Date('2026-11-01T12:00:00Z');
    const proposed = await call('POST', '/v1/admin/flags/wallet.enabled/flips', { to: true, reason: 'partner back' }, await staffToken('admin-1'));
    expect(proposed.body).toMatchObject({ status: 'awaiting_second_approval' });
    expect((await status()).body).toMatchObject({ capabilities: { wallet: 'degraded' } });
    expect((await call('POST', `/v1/admin/flag-flips/${(proposed.body as { id: string }).id}/approve`, undefined, await staffToken('admin-2'))).status).toBe(200);
    expect(await status().then((x) => x.body)).toEqual({ capabilities: { wallet: 'ok', card: 'off', p2p: 'ok', fx: 'off', payouts: 'off' } });
  });

  it('an incident goes only with switching off, short and plain', async () => {
    const admin = await staffToken('admin-1');
    expect((await call('POST', '/v1/admin/flags/fx.enabled/flips', { to: true, reason: 'launch', incident: { title: 'x', body: 'y' } }, admin)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('POST', '/v1/admin/flags/p2p.enabled/flips', { to: false, reason: 'outage', incident: { title: 'x'.repeat(81), body: 'y' } }, admin)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('POST', '/v1/admin/flags/p2p.enabled/flips', { to: false, reason: 'outage', incident: { title: 'Paused', body: 'Spoof ‮evil' } }, admin)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('POST', '/v1/admin/flags/p2p.enabled/flips', { to: false, reason: 'outage', incident: { title: 'Paused' } }, admin)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a capability whose flag is on but whose provider is not bound for the market is off; flags with no incident store have no incident', async () => {
    const flags = new StaticFlags(undefined, { 'fx.enabled': true, 'p2p.enabled': true });
    const registry = { bindingFor: (capability: string) => (capability === 'fx' ? undefined : host.registry.bindingFor(capability, 'IL')) };
    expect(await serviceStatus({ flags, registry, market: 'IL' })).toEqual({ capabilities: { wallet: 'off', card: 'off', p2p: 'ok', fx: 'off', payouts: 'off' } });
  });
});

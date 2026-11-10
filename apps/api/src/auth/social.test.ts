// T-0691 (REQ-AUTH-004): Sign in with Apple and Google, offered together or not at all, behind auth.social.enabled.
// Driven through the real app over the HTTP dispatcher: the providers list, FEATURE_OFF while the flag is off, a verified
// identity token for a linked member signing in like a passkey does (same token pair, new-device event), NOT_FOUND with no
// member created for an unknown identity, and every rejected token. The audience, expiry and signature checks themselves
// are the adapters' and run in the FederatedIdPPort contract suite; here the simulator's fixtures stand in for them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { createApp, type App } from '../app.ts';
import { StaticFlags, type FeatureFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { SocialTokenRevoker } from './social.ts';
import { generateSigningKey } from './tokens.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
let social = false;
const NOW = new Date('2026-11-10T09:00:00Z');
const ISSUER = 'https://api.kesher.example';
const base = new StaticFlags();
const flags: FeatureFlags = { isOn: (k) => (k === 'auth.social.enabled' ? social : base.isOn(k)), keys: () => base.keys() };

async function member(phone: string): Promise<string> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `first-${phone}`, deviceName: 'Phone' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `first-${phone}`, deviceName: 'Phone', response: await device.register(r1.options!) });
  return (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
}
const link = (partyId: string, provider: 'apple' | 'google', subject: string) => db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('member', $1, $2, $3)`, [partyId, provider, subject]);
const get = (url: string) => dispatch(app, { method: 'GET', url, headers: {}, rawBody: '', now: NOW });
const signIn = (body: unknown) => dispatch(app, { method: 'POST', url: '/v1/auth/social/sign-in', headers: {}, rawBody: JSON.stringify(body), now: NOW });
const users = async () => Number((await db.query<{ n: string }>('select count(*) as n from identity.user_account')).rows[0]!.n);
const events = () => app.services.passkeys.events.filter((e) => e.type === 'new_device_sign_in');

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: ISSUER, clock: () => NOW, flags });
}, 60_000);
afterAll(async () => db.close());

describe('T-0691: Sign in with Apple and Google', () => {
  it('with the flag off lists no provider and the sign-in route answers FEATURE_OFF 404', async () => {
    social = false;
    const list = await get('/v1/auth/social/providers');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ providers: [] });
    const r = await signIn({ provider: 'apple', idToken: 'ok:noa:nonce=n1', nonce: 'n1', deviceId: 'd-1' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'FEATURE_OFF' });
  });

  it('with the flag on lists Apple and Google together', async () => {
    social = true;
    expect((await get('/v1/auth/social/providers')).body).toEqual({ providers: ['apple', 'google'] });
  });

  it('signs in a linked member with a verified token: the passkey sign-in token pair and a new-device event, once per device', async () => {
    social = true;
    const partyId = await member('+972501260001');
    await link(partyId, 'apple', 'apple:dana');
    const before = events().length;
    const r = await signIn({ provider: 'apple', idToken: 'ok:dana:nonce=n1', nonce: 'n1', deviceId: 'ipad-1' });
    expect(r.status).toBe(200);
    const { tokens } = r.body as { tokens: { accessToken: string; refreshToken: string; accessExpiresAt: string } };
    expect(await app.services.tokens.verifyAccess(tokens.accessToken)).toMatchObject({ partyId });
    expect(events().length).toBe(before + 1);
    expect(events().at(-1)).toMatchObject({ partyId, deviceId: 'ipad-1' });
    // The session is a real one: its refresh token rotates for the same device.
    const refreshed = await dispatch(app, { method: 'POST', url: '/v1/auth/token/refresh', headers: { authorization: `Bearer ${tokens.refreshToken}` }, rawBody: JSON.stringify({ deviceId: 'ipad-1' }), now: NOW });
    expect(refreshed.status).toBe(200);
    // The same device again is not new.
    expect((await signIn({ provider: 'apple', idToken: 'ok:dana:nonce=n1', nonce: 'n1', deviceId: 'ipad-1' })).status).toBe(200);
    expect(events().length).toBe(before + 1);
  });

  it('keeps the two providers apart: a Google identity with the same name is not the Apple link', async () => {
    social = true;
    const r = await signIn({ provider: 'google', idToken: 'ok:dana:nonce=n1', nonce: 'n1', deviceId: 'ipad-1' });
    expect(r.status).toBe(404);
  });

  it('answers NOT_FOUND for an unknown identity and creates no member', async () => {
    social = true;
    const before = await users();
    const r = await signIn({ provider: 'google', idToken: 'ok:stranger:nonce=n1', nonce: 'n1', deviceId: 'd-9' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(await users()).toBe(before);
  });

  it('rejects a token for the wrong audience, an expired one, a bad signature and a wrong nonce with 401 and issues nothing', async () => {
    social = true;
    const partyId = await member('+972501260002');
    await link(partyId, 'google', 'google:eli');
    for (const idToken of ['badaud', 'expired', 'badsig', 'not-a-token', 'ok:eli:nonce=other']) {
      const r = await signIn({ provider: 'google', idToken, nonce: 'n1', deviceId: 'd-2' });
      expect(r.status, idToken).toBe(401);
      expect(r.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(events().some((e) => e.partyId === partyId && e.deviceId === 'd-2')).toBe(false);
  });

  it('refuses a closed account, an unknown provider and a missing field; answers 503 while the provider is down', async () => {
    social = true;
    const partyId = await member('+972501260003');
    await link(partyId, 'apple', 'apple:closed');
    await app.services.identity.setUserStatus(partyId, 'closed');
    expect((await signIn({ provider: 'apple', idToken: 'ok:closed:nonce=n1', nonce: 'n1', deviceId: 'd-3' })).status).toBe(401);
    expect((await signIn({ provider: 'facebook', idToken: 'ok:x', nonce: 'n1', deviceId: 'd-3' })).status).toBe(422);
    expect((await signIn({ provider: 'apple', idToken: 'ok:x', deviceId: 'd-3' })).status).toBe(422);
    expect((await signIn({ provider: 'apple', idToken: 'outage', nonce: 'n1', deviceId: 'd-3' })).status).toBe(503);
  });

  // T-0692: the revoker alone, on a token that cannot be opened (the closure tests cover the rest end to end).
  it('SocialTokenRevoker: a stored token that cannot be unsealed opens the case with a code only and is erased; with none it does nothing', async () => {
    const partyId = await member('+972501260004');
    const revoker = new SocialTokenRevoker({ db, links: app.services.socialLinks, port: () => host.simulators['federated-idp'] });
    await revoker.revokeForClosure(partyId, NOW);
    expect((await db.query(`select 1 from ops.case where dedupe_key = $1`, [`apple-revoke:${partyId}`])).rows).toHaveLength(0);

    await app.services.identity.linkFederated({ partyId, provider: 'apple', subject: `apple:${partyId}`, refreshTokenSealed: new Uint8Array(40).fill(7), createdAt: NOW.toISOString() });
    const before = host.simulators['federated-idp'].revoked.length;
    await revoker.revokeForClosure(partyId, NOW);
    await revoker.revokeForClosure(partyId, NOW);
    expect(host.simulators['federated-idp'].revoked.length).toBe(before);
    expect(await app.services.identity.findFederatedToken(partyId, 'apple')).toBeUndefined();
    const rows = (await db.query<{ payload: unknown }>(`select payload from ops.case where dedupe_key = $1`, [`apple-revoke:${partyId}`])).rows;
    expect(rows).toEqual([{ payload: { partyId, provider: 'apple', failure: 'REVOKE_FAILED' } }]);
  });
});

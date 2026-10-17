// Staff tokens (T-0906, ADR-013): only the console's key, the staff audience and a fresh token
// yield a staff principal; member tokens never reach /admin/*, staff tokens never pass as members.
import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { fixedClock } from '@kesher/ports';
import { makeRequest } from '../http.ts';
import { looksLikeStaffToken, requireStaff, STAFF_AUDIENCE, STAFF_ISSUER, staffBearerMiddleware, staffPartyId, StaffTokenVerifier } from './staff-token.ts';

const NOW = new Date('2026-11-01T09:00:00Z');
const at = (d: Date) => Math.floor(d.getTime() / 1000);

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  const sign = (claims: Record<string, unknown>, o: { iss?: string; aud?: string; iat?: Date; exp?: Date; key?: CryptoKey } = {}) =>
    new SignJWT({ roles: ['ops'], ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'admin-1' })
      .setIssuer(o.iss ?? STAFF_ISSUER)
      .setAudience(o.aud ?? STAFF_AUDIENCE)
      .setSubject('zvi')
      .setIssuedAt(at(o.iat ?? NOW))
      .setExpirationTime(at(o.exp ?? new Date(NOW.getTime() + 5 * 60_000)))
      .sign(o.key ?? privateKey);
  return { jwk, sign, privateKey };
}

describe('StaffTokenVerifier', () => {
  it('maps a valid token to a staff principal with the admin role and the SSO roles', async () => {
    const { jwk, sign } = await keys();
    const v = new StaffTokenVerifier({ jwks: [jwk], clock: fixedClock(NOW.toISOString()) });
    const p = await v.verify(await sign({ roles: ['ops', 'compliance'], sid: 'sess-1' }));
    expect(p).toEqual({ kind: 'staff', partyId: staffPartyId('zvi'), subject: 'zvi', roles: ['admin', 'ops', 'compliance'], sessionId: 'sess-1', deviceId: 'admin-console' });
    expect(staffPartyId('zvi')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(staffPartyId('zvi')).toBe(staffPartyId('zvi'));
    expect(staffPartyId('zvi')).not.toBe(staffPartyId('zv1'));
  });

  it('rejects the wrong audience, issuer or key, an expired token and a token older than 5 minutes', async () => {
    const { jwk, sign } = await keys();
    const other = await keys();
    const v = new StaffTokenVerifier({ jwks: [jwk], clock: fixedClock(NOW.toISOString()) });
    for (const t of [
      await sign({}, { aud: 'https://api.kesher.example' }),
      await sign({}, { iss: 'https://evil.example' }),
      await sign({}, { key: other.privateKey }),
      await sign({}, { exp: new Date(NOW.getTime() - 1000) }),
      await sign({}, { iat: new Date(NOW.getTime() - 6 * 60_000), exp: new Date(NOW.getTime() + 60_000) }),
      'not.a.jwt',
    ]) {
      await expect(v.verify(t)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(() => new StaffTokenVerifier({ jwks: [], clock: fixedClock() })).toThrow(/empty/);
  });

  it('the middleware only intercepts bearers that claim the staff audience, and 401s when staff access is off', async () => {
    const { jwk, sign } = await keys();
    const staff = await sign({});
    const memberLike = await sign({}, { aud: 'https://api.kesher.example' });
    expect(looksLikeStaffToken(staff)).toBe(true);
    expect(looksLikeStaffToken(memberLike)).toBe(false);
    expect(looksLikeStaffToken('garbage')).toBe(false);
    const on = staffBearerMiddleware(new StaffTokenVerifier({ jwks: [jwk], clock: fixedClock(NOW.toISOString()) }));
    expect((await on(makeRequest({ method: 'GET', path: '/admin/flags', headers: { authorization: `Bearer ${staff}` } }))).principal?.kind).toBe('staff');
    expect((await on(makeRequest({ method: 'GET', path: '/me/capabilities', headers: { authorization: `Bearer ${memberLike}` } }))).principal).toBeUndefined();
    const off = staffBearerMiddleware(undefined);
    await expect(off(makeRequest({ method: 'GET', path: '/admin/flags', headers: { authorization: `Bearer ${staff}` } }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('requireStaff refuses members and agents even with an admin role, and checks staff roles', () => {
    const member = makeRequest({ method: 'GET', path: '/admin/flags', principal: { partyId: 'p1', roles: ['admin'], sessionId: 's', deviceId: 'd' } });
    expect(() => requireStaff(member)).toThrow(/staff session/);
    const staff = makeRequest({ method: 'GET', path: '/admin/flags', principal: { kind: 'staff', partyId: staffPartyId('zvi'), subject: 'zvi', roles: ['admin', 'ops'], sessionId: 's', deviceId: 'admin-console' } });
    expect(requireStaff(staff, 'ops').subject).toBe('zvi');
    expect(() => requireStaff(staff, 'compliance')).toThrow(/Needs one of/);
    expect(() => requireStaff(makeRequest({ method: 'GET', path: '/admin/flags' }))).toThrow(/sign-in/);
  });
});

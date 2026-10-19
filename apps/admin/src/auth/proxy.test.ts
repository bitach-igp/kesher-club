// TST-AUTH-009 (REQ-AUTH-009): admin access is SSO + phishing-resistant MFA, reachable only over the VPN.
// Given a non-VPN IP, when /admin is requested, then 403.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { parseCidr } from './vpn.ts';
import { adminProxy, PROXY_MATCHER, type ProxyEnv } from './proxy.ts';
import { parseAdminConfig } from '../config.ts';

const ISSUER = 'https://idc.example.com/oidc';
const AUDIENCE = 'kesher-admin';
const NOW = new Date('2026-11-01T09:00:00Z');

async function makeEnv() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const env: ProxyEnv = { cidrs: [parseCidr('10.8.0.0/16')!, parseCidr('fd00:1234::/48')!], verifier: { jwks: createLocalJWKSet({ keys: [jwk] }), issuer: ISSUER, audience: AUDIENCE }, now: NOW };
  const token = (claims: Record<string, unknown>, opts: { exp?: Date; iss?: string } = {}) =>
    new SignJWT({ amr: ['hwk', 'mfa'], roles: ['ops'], ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('admin-1')
      .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 60)
      .setExpirationTime(opts.exp ?? Math.floor(NOW.getTime() / 1000) + 3600)
      .sign(privateKey);
  return { env, token };
}

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const req = (path: string, ip: string, cookie?: string) => ({ path, headers: headers({ 'x-forwarded-for': ip }), sessionCookie: cookie });

describe('admin proxy (TST-AUTH-009)', () => {
  it('a non-VPN IP gets 403 for every path, the sign-in page included, with the same body', async () => {
    const { env, token } = await makeEnv();
    const good = await token({});
    for (const path of ['/', '/customers/abc', '/auth/sign-in', '/providers']) {
      const r = await adminProxy(req(path, '203.0.113.9', good), env);
      expect(r).toMatchObject({ kind: 'forbidden', status: 403, problem: { code: 'FORBIDDEN' } });
    }
    // Spoofing: only the first hop of x-forwarded-for counts, and a missing or junk IP is never allowed.
    expect((await adminProxy({ path: '/', headers: headers({ 'x-forwarded-for': '203.0.113.9, 10.8.1.1' }), sessionCookie: good }, env)).kind).toBe('forbidden');
    expect((await adminProxy({ path: '/', headers: headers({}), sessionCookie: good }, env)).kind).toBe('forbidden');
    expect((await adminProxy({ path: '/', headers: headers({ 'x-forwarded-for': 'not-an-ip' }), sessionCookie: good }, env)).kind).toBe('forbidden');
  });

  it('a VPN IP without a session is sent to sign-in with the return path; the sign-in flow itself passes', async () => {
    const { env } = await makeEnv();
    const r = await adminProxy({ path: '/customers/abc', search: '?tab=cases', headers: headers({ 'x-forwarded-for': '10.8.3.4' }), sessionCookie: undefined }, env);
    expect(r).toEqual({ kind: 'redirect', reason: 'no_session', location: '/auth/sign-in?reason=no_session&return_to=%2Fcustomers%2Fabc%3Ftab%3Dcases' });
    for (const path of ['/auth/sign-in', '/auth/start', '/auth/callback']) expect((await adminProxy(req(path, '10.8.3.4'), env)).kind).toBe('next');
    expect((await adminProxy({ path: '/', headers: headers({ 'x-forwarded-for': '::ffff:10.8.3.4' }), sessionCookie: undefined }, env)).kind).toBe('redirect');
    expect((await adminProxy({ path: '/', headers: headers({ 'x-real-ip': 'fd00:1234::7' }), sessionCookie: undefined }, env)).kind).toBe('redirect');
  });

  it('a valid session signed by Identity Center with a phishing-resistant authenticator passes with its identity', async () => {
    const { env, token } = await makeEnv();
    const r = await adminProxy(req('/customers/abc', '10.8.3.4', await token({ amr: ['fido'], roles: ['ops', 'compliance'] })), env);
    expect(r).toEqual({ kind: 'next', subject: 'admin-1', roles: ['ops', 'compliance'] });
    expect((await adminProxy(req('/', '10.8.3.4', await token({ amr: ['swk', 'fido'] })), env)).kind).toBe('next');
  });

  it('password-only, expired, wrong-issuer or tampered sessions are refused with a specific reason', async () => {
    const { env, token } = await makeEnv();
    const reason = async (t: string) => {
      const r = await adminProxy(req('/', '10.8.3.4', t), env);
      return r.kind === 'redirect' ? r.reason : r.kind;
    };
    expect(await reason(await token({ amr: ['pwd', 'otp'] }))).toBe('hardware_key_required');
    expect(await reason(await token({}, { exp: new Date('2026-11-01T08:59:00Z') }))).toBe('expired');
    expect(await reason(await token({}, { iss: 'https://evil.example' }))).toBe('invalid');
    const good = await token({});
    expect(await reason(`${good.slice(0, -4)}AAAA`)).toBe('invalid');
    expect(await reason('not.a.jwt')).toBe('invalid');
  });

  it('boot config: every OIDC, VPN and data setting is required; nothing falls back to a default', async () => {
    const signing = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey);
    const env = {
      NODE_ENV: 'production',
      ADMIN_ENVIRONMENT: 'production',
      ADMIN_BASE_URL: 'https://admin.kesher.example',
      ADMIN_VPN_CIDRS: '10.8.0.0/16, fd00:1234::/48',
      ADMIN_OIDC_ISSUER: ISSUER,
      ADMIN_OIDC_AUDIENCE: AUDIENCE,
      ADMIN_OIDC_CLIENT_ID: 'client',
      ADMIN_OIDC_CLIENT_SECRET: 'secret',
      ADMIN_OIDC_JWKS_URL: `${ISSUER}/keys`,
      ADMIN_DATA: 'api',
      ADMIN_API_URL_IL: 'https://api-il.kesher.example/v1',
      ADMIN_API_URL_US: 'https://api-us.kesher.example/v1',
      ADMIN_API_SIGNING_KEY: JSON.stringify(signing),
      ADMIN_API_SIGNING_KID: 'admin-1',
    };
    expect(parseAdminConfig(env).ADMIN_VPN_CIDRS.map((c) => c.text)).toEqual(['10.8.0.0/16', 'fd00:1234::/48']);
    expect(() => parseAdminConfig({ ...env, ADMIN_OIDC_CLIENT_SECRET: undefined })).toThrow(/ADMIN_OIDC_CLIENT_SECRET/);
    expect(() => parseAdminConfig({ ...env, ADMIN_VPN_CIDRS: '0.0.0.0/33' })).toThrow();
    // The boot log prints this message (T-0918): it names the key and the entry, never the value.
    const bad = (() => { try { parseAdminConfig({ ...env, ADMIN_VPN_CIDRS: '10.8.0.0/16, vpn-range-typo' }); } catch (e) { return (e as Error).message; } return ''; })();
    expect(bad).toMatch(/ADMIN_VPN_CIDRS: entry 2 is not a CIDR/);
    expect(bad).not.toContain('vpn-range-typo');
    // ADR-013: the API binding needs its URL and signing key; the seeded store is for local and preview only.
    expect(() => parseAdminConfig({ ...env, ADMIN_API_SIGNING_KEY: undefined })).toThrow(/ADMIN_API_SIGNING_KEY/);
    // One API per market (T-0913): both are required, and boot names the one missing.
    expect(() => parseAdminConfig({ ...env, ADMIN_API_URL_US: undefined })).toThrow(/ADMIN_API_URL_US/);
    expect(() => parseAdminConfig({ ...env, ADMIN_API_URL_IL: undefined })).toThrow(/ADMIN_API_URL_IL/);
    expect(() => parseAdminConfig({ ...env, ADMIN_API_SIGNING_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }) })).toThrow(/private/);
    expect(() => parseAdminConfig({ ...env, ADMIN_DATA: 'memory' })).toThrow(/local and preview/);
    expect(parseAdminConfig({ ...env, ADMIN_DATA: 'memory', ADMIN_ENVIRONMENT: 'preview', NODE_ENV: 'preview' }).ADMIN_DATA).toBe('memory');
  });

  it('the Next proxy exports PROXY_MATCHER as the literal next build requires (T-0915)', () => {
    const source = fs.readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8');
    const literal = /export const config = \{ matcher: (\[[^\]]*\]) \};/.exec(source)?.[1];
    expect(literal && (JSON.parse(literal.replaceAll("'", '"')) as unknown)).toEqual(PROXY_MATCHER);
  });
});

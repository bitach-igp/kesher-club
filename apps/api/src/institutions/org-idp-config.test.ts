// TST-AUTH-008 (T-1123): boot validation of the orgIdp URLs and the callback floor, a table of accepted and refused values.
import { describe, expect, it } from 'vitest';
import { MAX_CALLBACK_FLOOR_MS, validateOrgIdpConfig } from './org-idp-config.ts';

const CON = 'https://console.kesher.example/sso';
const CB = 'https://api.kesher.example/v1/sso/callback';
const run = (consoleUrl: string | undefined, callbackUrl: string | undefined, prod = true) => () => validateOrgIdpConfig({ consoleUrl, callbackUrl }, prod);

describe('orgIdp.consoleUrl', () => {
  const ok: [string, boolean][] = [
    [CON, true], [CON, false], ['https://console.kesher.example', true], ['https://console.kesher.example/', true], ['https://console.kesher.example:8443/sso', true],
    ['HTTPS://Console.Kesher.Example/sso', true], ['https://bücher.example/sso', true], ['https://xn--bcher-kva.example/sso', true],
    ['https://[2001:db8::1]/sso', true], ['https://console.kesher.example/a%20b', true],
    ['http://localhost:5173/sso', false], ['http://127.0.0.1/sso', false], ['http://[::1]:3000/sso', false], ['https://localhost/sso', false], ['HTTP://LOCALHOST/sso', false],
  ];
  it.each(ok)('accepts %s (production %s)', (url, prod) => {
    const cb = url.toLowerCase().startsWith('http:') ? 'http://localhost:3000/v1/sso/callback' : CB;
    expect(validateOrgIdpConfig({ consoleUrl: url, callbackUrl: cb }, prod)).toEqual({ consoleUrl: url, callbackUrl: cb });
  });
  const bad: [string, string, boolean][] = [
    ['trailing empty hash', `${CON}#`, false], ['fragment', `${CON}#x=1`, false], ['query', `${CON}?a=1`, false], ['empty query', `${CON}?`, false],
    ['userinfo', 'https://user:pass@console.kesher.example/sso', false], ['empty userinfo', 'https://@console.kesher.example/sso', false], ['user only', 'https://user@console.kesher.example/', false],
    ['javascript scheme', 'javascript://localhost/%0aalert(1)', false], ['javascript no authority', 'javascript:alert(1)', false], ['data', 'data:text/html,hi', false], ['file', 'file://localhost/etc/passwd', false],
    ['ftp', 'ftp://console.kesher.example/', false], ['scheme-relative', '//console.kesher.example/sso', false], ['relative path', '/sso', false], ['no scheme', 'console.kesher.example/sso', false],
    ['http remote', 'http://console.kesher.example/sso', false], ['http localhost lookalike', 'http://localhost.evil.example/sso', false], ['http 127 lookalike', 'http://127.0.0.1.evil.example/sso', false],
    ['http short loopback', 'http://127.1/sso', false], ['http encoded localhost', 'http://%6Cocalhost/sso', false], ['http other loopback', 'http://127.0.0.2/sso', false], ['http userinfo trick', 'http://localhost@evil.example/sso', false],
    ['http localhost in production', 'http://localhost/sso', true], ['http 127 in production', 'http://127.0.0.1/sso', true], ['http ::1 in production', 'http://[::1]/sso', true],
    ['https localhost in production', 'https://localhost/sso', true], ['https 127 in production', 'https://127.0.0.1/sso', true],
    ['trailing dot host', 'https://console.kesher.example./sso', false], ['https 127.1 spelled short','https://127.1/sso',false],['port 00','https://console.kesher.example:00/sso',false],['backslash in path','https://console.kesher.example/a\\b',false],['port 0', 'https://console.kesher.example:0/sso', false], ['bad port', 'https://console.kesher.example:99999/sso', false],
    ['encoded host', 'https://console%2ekesher.example/sso', false], ['leading space', ` ${CON}`, false], ['trailing space', `${CON} `, false], ['inner space', 'https://console.kesher.example/a b', false],
    ['tab', 'https://console.kesher.example/\tsso', false], ['newline', `${CON}\n`, false], ['backslash', 'https:\\\\console.kesher.example\\sso', false], ['NUL', `${CON}\u0000`, false], ['empty host', 'https:///sso', false], ['empty', '', false],
  ];
  it.each(bad)('refuses %s', (_n, url, prod) => {
    expect(run(url, url.startsWith('http:') ? 'http://localhost/v1/sso/callback' : CB, prod)).toThrow(/orgIdp\.(consoleUrl|callbackUrl)/);
  });
  it('refuses with the option named and the value never echoed', () => {
    const secret = 'https://user:s3cr3t-pw@console.kesher.example/sso?token=s3cr3t-tok#frag';
    let msg = '';
    try { validateOrgIdpConfig({ consoleUrl: secret, callbackUrl: CB }, true); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^orgIdp\.consoleUrl /);
    expect(msg).not.toMatch(/s3cr3t|console\.kesher|user:/);
  });
});

describe('orgIdp.callbackUrl', () => {
  it.each([
    [CB], ['https://api.kesher.example:8443/v1/sso/callback'], ['https://bücher.example/v1/sso/callback'],
  ])('accepts %s', (cb) => expect(validateOrgIdpConfig({ consoleUrl: CON, callbackUrl: cb }, true)?.callbackUrl).toBe(cb));
  it('accepts a loopback pair outside production only', () => {
    const c = { consoleUrl: 'http://localhost:5173/sso', callbackUrl: 'http://localhost:3000/v1/sso/callback' };
    expect(validateOrgIdpConfig(c, false)).toEqual(c);
    expect(() => validateOrgIdpConfig(c, true)).toThrow(/https in production/);
  });
  it.each([
    ['wrong path', 'https://api.kesher.example/sso/callback'], ['trailing slash', `${CB}/`], ['upper-case path', 'https://api.kesher.example/V1/SSO/callback'], ['no path', 'https://api.kesher.example'],
    ['extra segment', `${CB}/x`], ['dot segments', 'https://api.kesher.example/v1/x/../sso/callback'], ['encoded slash', 'https://api.kesher.example/v1%2Fsso/callback'], ['encoded char', 'https://api.kesher.example/v1/sso/call%62ack'],
    ['query', `${CB}?a=1`], ['empty query', `${CB}?`], ['fragment', `${CB}#`], ['userinfo', 'https://u:p@api.kesher.example/v1/sso/callback'],
    ['javascript', 'javascript://localhost/v1/sso/callback'], ['data', 'data:text/plain,x'], ['http remote', 'http://api.kesher.example/v1/sso/callback'], ['space', `${CB} `],
    ['trailing dot', 'https://api.kesher.example./v1/sso/callback'], ['http localhost in production', 'http://localhost/v1/sso/callback'],
  ])('refuses %s', (_n, cb) => expect(run(CON, cb)).toThrow(/orgIdp\.callbackUrl/));
  it.each([['http://localhost/v1/sso/callback', /callbackUrl must be https in production/], ['https://localhost/v1/sso/callback', /callbackUrl must not be a loopback host in production/]])('refuses %s as callback in production', (cb, re) => {
    expect(run(CON, cb, true)).toThrow(re);
  });
  it('refuses a scheme mismatch between the two (outside production)', () => {
    expect(() => validateOrgIdpConfig({ consoleUrl: 'http://localhost/sso', callbackUrl: CB }, false)).toThrow(/same scheme/);
    expect(() => validateOrgIdpConfig({ consoleUrl: CON, callbackUrl: 'http://localhost/v1/sso/callback' }, false)).toThrow(/same scheme/);
  });
});

describe('presence and floor', () => {
  it('is off with neither URL, refuses exactly one', () => {
    expect(validateOrgIdpConfig(undefined, true)).toBeUndefined();
    expect(validateOrgIdpConfig({}, true)).toBeUndefined();
    expect(validateOrgIdpConfig({ consoleUrl: '', callbackUrl: '' }, true)).toBeUndefined();
    expect(run(CON, undefined)).toThrow(/set together/);
    expect(run(undefined, CB)).toThrow(/set together/);
    expect(run(CON, '')).toThrow(/set together/);
  });
  it.each([0, 1, 400, 5000, MAX_CALLBACK_FLOOR_MS])('accepts a floor of %s', (ms) => expect(validateOrgIdpConfig({ callbackFloorMs: ms }, true)).toBeUndefined());
  it.each([-1, NaN, Infinity, -Infinity, 0.5, 5001, 1e9])('refuses a floor of %s, even with no URLs', (ms) => {
    expect(() => validateOrgIdpConfig({ callbackFloorMs: ms }, false)).toThrow(/orgIdp\.callbackFloorMs/);
  });
});

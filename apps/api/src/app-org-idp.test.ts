// TST-AUTH-008 (T-1123): createApp refuses unsafe orgIdp options at boot, with a message that names the option and holds no secret.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from './auth/tokens.ts';
import { createApp, type AppOptions } from './app.ts';
import { createTestDatabase, type TestDatabase } from './test-db.ts';

let db: TestDatabase;
let base: AppOptions;
beforeAll(async () => {
  db = await createTestDatabase();
  base = { db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example' } as AppOptions;
}, 120_000);
afterAll(async () => db.close());

const CB = 'https://api.kesher.example/v1/sso/callback';
describe('createApp orgIdp boot checks (T-1123)', () => {
  it('boots with good URLs, with none, and with a loopback pair outside production', () => {
    expect(() => createApp({ ...base, orgIdp: { consoleUrl: 'https://console.kesher.example/sso', callbackUrl: CB, callbackFloorMs: 0 } })).not.toThrow();
    expect(() => createApp({ ...base, orgIdp: {} })).not.toThrow();
    expect(() => createApp({ ...base, orgIdp: { consoleUrl: 'http://localhost:5173/sso', callbackUrl: 'http://localhost:3000/v1/sso/callback' } })).not.toThrow();
  });
  it('throws a clear message with no secret for each unsafe option', () => {
    const cases: [NonNullable<AppOptions['orgIdp']>, boolean, RegExp][] = [
      [{ consoleUrl: 'https://u:topsecret@console.kesher.example/sso#', callbackUrl: CB }, false, /orgIdp\.consoleUrl must not contain userinfo/],
      [{ consoleUrl: 'https://console.kesher.example/sso?k=topsecret', callbackUrl: CB }, false, /consoleUrl must not contain a query or a fragment/],
      [{ consoleUrl: 'https://console.kesher.example/sso#', callbackUrl: CB }, false, /consoleUrl must not contain a query or a fragment/],
      [{ consoleUrl: 'https://console.kesher.example/sso', callbackUrl: `${CB}?topsecret=1` }, false, /callbackUrl must not contain a query/],
      [{ consoleUrl: 'https://console.kesher.example/sso', callbackUrl: 'https://api.kesher.example/other?x=topsecret' }, false, /callbackUrl/],
      [{ consoleUrl: 'https://console.kesher.example/sso', callbackUrl: 'https://api.kesher.example/v1/topsecret' }, false, /callbackUrl path must be exactly \/v1\/sso\/callback/],
      [{ consoleUrl: 'javascript://localhost/topsecret', callbackUrl: CB }, false, /consoleUrl must be an https URL/],
      [{ consoleUrl: 'http://localhost/sso', callbackUrl: 'http://localhost/v1/sso/callback' }, true, /must be https in production/],
      [{ consoleUrl: 'https://console.kesher.example/sso', callbackUrl: CB, callbackFloorMs: 60_000 }, false, /callbackFloorMs/],
      [{ consoleUrl: 'https://console.kesher.example/sso' }, false, /set together/],
    ];
    for (const [orgIdp, prod, re] of cases) {
      let msg = '';
      try { createApp({ ...base, orgIdp, ...(prod ? { refuseFlagsOnSimulators: true } : {}) }); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(re);
      expect(msg).not.toMatch(/topsecret|console\.kesher|api\.kesher/);
    }
  });
});

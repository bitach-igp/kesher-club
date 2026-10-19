// T-0031: the API, the jobs and the simulators' panel share one registry and one clock, so a flow can be
// driven end to end on the running stack: an ACH load posted to the API is held, the vendor confirms it
// through a panel hook, the panel's clock moves past the hold, the release job settles it, and the
// member's balance read through the API shows the money. Anything but APP_ENV=development refuses to boot.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { startDev, type RunningDev } from './dev.ts';

let db: TestDatabase;
let dev: RunningDev;
let access = '';
let refresh = '';
let stepUp = '';
let member = '';

const DAY_MS = 86_400_000;
const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${dev.apiPort}/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${access}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const panel = (path: string, body: unknown) => fetch(`http://127.0.0.1:${dev.panelPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const usd = async () => {
  const res = await api('GET', '/accounts');
  expect(res.status).toBe(200);
  const p = ((await res.json()) as { items: { currency: string; available: { minor: string }; holds: { minor: string } }[] }).items.find((a) => a.currency === 'USD')!;
  return { available: BigInt(p.available.minor), holds: BigInt(p.holds.minor) };
};

beforeAll(async () => {
  db = await createTestDatabase();
  dev = await startDev({ APP_ENV: 'development', DATABASE_URL: 'postgres://demo@localhost/unused', MARKET: 'US' }, { db, schedule: false, ports: { api: 0, panel: 0 } });
  const s = dev.app.services;
  const started = await s.otp.start({ phone: '+15555550100', locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'demo-1', deviceName: 'Demo' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'demo-1', deviceName: 'Demo', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  refresh = r2.tokens!.refreshToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  stepUp = (await s.stepUp.complete(principal, await device.authenticate((await s.stepUp.start(principal)).options))).stepUpToken;
}, 60_000);
afterAll(async () => {
  await dev?.shutdown();
  await db?.close();
});

describe('one process, one registry, one clock (T-0031)', () => {
  it('an ACH load is held, confirmed through a panel hook, released by the job after the panel moves the clock, and shows in the balance', async () => {
    const before = await usd();
    const res = await api('POST', '/loads', { memberPartyId: member, amount: { minor: '5000', currency: 'USD' }, method: 'ach', paymentMethodId: 'pm_bank' }, { 'idempotency-key': 'demo-ach-load-1', 'x-step-up': stepUp });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ state: 'on_hold' });
    const transfer = (await dev.app.services.transfers.byKey('demo-ach-load-1'))!;
    expect(transfer.state).toBe('pending_hold');
    expect(await usd()).toEqual({ available: before.available, holds: before.holds + 5_000n });

    // The panel drives the API's own vendor: a separate simulator host has never heard of this load.
    const vendorLoad = (await dev.app.services.loads.vendorLoadOf(transfer.id))!;
    expect(() => new SimulatorHost().simulators.funding.webhookFor(vendorLoad, 'succeeded')).toThrow();
    const hook = (await (await panel('/ports/funding/hooks/settle', { loadId: vendorLoad, status: 'succeeded' })).json()) as { ok: boolean; result: { headers: Record<string, string>; rawBody: string } };
    expect(hook.ok).toBe(true);
    const delivered = await fetch(`http://127.0.0.1:${dev.apiPort}/v1/hooks/funding`, { method: 'POST', headers: hook.result.headers, body: hook.result.rawBody });
    expect(delivered.status).toBe(200);

    // Confirmed but still inside the hold: the release job leaves it alone.
    await dev.runJob('ach-release-holds');
    expect((await dev.app.services.transfers.get(transfer.id))!.state).toBe('pending_hold');

    // The panel moves the one clock past the hold; the job, on that clock, releases it.
    const advanced = (await (await panel('/clock/advance', { ms: 7 * DAY_MS })).json()) as { now: string };
    expect(Math.abs(dev.clock.now().getTime() - Date.parse(advanced.now))).toBeLessThan(5_000); // the panel's clock is the jobs' clock
    expect(Date.parse(advanced.now)).toBeGreaterThan(Date.parse(transfer.holdReleasesAt!));
    await dev.runJob('ach-release-holds');
    expect((await dev.app.services.transfers.get(transfer.id))!.state).toBe('settled');
    // Seven days on, the API's clock has expired the 10-minute access token too: refresh it, as the app would.
    expect((await api('GET', '/accounts')).status).toBe(401);
    const pair = (await (await fetch(`http://127.0.0.1:${dev.apiPort}/v1/auth/token/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${refresh}` }, body: JSON.stringify({ deviceId: 'demo-1' }) })).json()) as { accessToken: string };
    access = pair.accessToken;
    expect(await usd()).toEqual({ available: before.available + 5_000n, holds: before.holds });
  });

  it('refuses to boot outside development: one boot_failed line, exit 1', async () => {
    const entry = fileURLToPath(new URL('./dev.ts', import.meta.url));
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', entry], { env: { ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}), APP_ENV: 'preview', DATABASE_URL: 'postgres://demo@localhost/unused' } });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'demo', event: 'boot_failed', error: 'ConfigError', message: expect.stringContaining('APP_ENV') });
    expect(out).not.toContain('preview');
  }, 30_000);
});

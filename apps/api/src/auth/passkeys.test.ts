// TST-AUTH-001 (passkey half) and TST-AUTH-002: enrol a passkey right after OTP; passkeys are the
// default sign-in with device binding; OTP is offered only for recovery.
import { randomBytes } from 'node:crypto';
import { Secret } from '@kesher/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthSimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { createPiiCipher } from '../crypto/pii.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { PostgresIdentityRepository } from './pg-repository.ts';
import { InMemoryIdentityRepository } from './repository.ts';
import { OtpService } from './otp.ts';
import { PasskeyService } from './passkeys.ts';
import { TokenService, generateSigningKey } from './tokens.ts';

async function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  const otp = new OtpService(port, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  const passkeys = new PasskeyService(port, repo, tokens, clock, otp);
  return { clock, repo, port, otp, tokens, passkeys };
}

async function registerUser(s: Awaited<ReturnType<typeof setup>>, phone = '+972501234567') {
  const { otpId } = await s.otp.start({ phone, locale: 'en' });
  const v = await s.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const step1 = await s.passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa’s iPhone' });
  const response = await device.register(step1.options!);
  const step2 = await s.passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa’s iPhone', response });
  return { device, tokens: step2.tokens!, credentialId: step2.credentialId! };
}

describe('PasskeyService registration (REQ-AUTH-001)', () => {
  it('OTP → options → verified response creates an active account with a stored passkey and signs in', async () => {
    const s = await setup();
    const { tokens, credentialId } = await registerUser(s);
    const principal = await s.tokens.verifyAccess(tokens.accessToken);
    const user = await s.repo.findUserByPhone('+972501234567');
    expect(user?.status).toBe('active');
    expect(principal.partyId).toBe(user!.partyId);
    const creds = await s.repo.listPasskeys(user!.partyId);
    expect(creds.map((c) => c.credentialId)).toEqual([credentialId]);
    expect(creds[0]!.deviceName).toBe('Noa’s iPhone');
  });

  it('registering the same phone twice is refused as a conflict', async () => {
    const s = await setup();
    await registerUser(s);
    await expect(registerUser(s)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('a signed-in user can add a passkey for a second device', async () => {
    const s = await setup();
    const { tokens } = await registerUser(s);
    const principal = await s.tokens.verifyAccess(tokens.accessToken);
    const device2 = new SimPasskeyDevice();
    const step1 = await s.passkeys.register({ principal, deviceId: 'pixel-1', deviceName: 'Pixel' });
    const step2 = await s.passkeys.register({ principal, deviceId: 'pixel-1', deviceName: 'Pixel', response: await device2.register(step1.options!) });
    expect(step2.credentialId).toBeTruthy();
    expect((await s.repo.listPasskeys(principal.partyId)).length).toBe(2);
  });

  it('a registration response for another challenge is rejected', async () => {
    const s = await setup();
    const { otpId } = await s.otp.start({ phone: '+972501234567', locale: 'en' });
    const v = await s.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
    const step1 = await s.passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd' });
    const forged = await new SimPasskeyDevice().register({ ...step1.options!, challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' });
    await expect(s.passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd', response: forged })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('PasskeyService authentication (REQ-AUTH-002)', () => {
  it('sign-in offers passkey options only (no OTP) and issues device-bound tokens on a valid assertion', async () => {
    const s = await setup();
    const { device } = await registerUser(s);
    const step1 = await s.passkeys.authenticate({ deviceId: 'iphone-1' });
    expect(step1.options?.userVerification).toBe('required');
    expect(step1).not.toHaveProperty('otp');
    expect(step1.recovery).toEqual({ label: "Can't use passkey?", path: '/auth/otp' });
    const step2 = await s.passkeys.authenticate({ deviceId: 'iphone-1', response: await device.authenticate(step1.options!) });
    const principal = await s.tokens.verifyAccess(step2.tokens!.accessToken);
    expect(principal.deviceId).toBe('iphone-1');
    expect(principal.restrictedUntil).toBeUndefined();
  });

  it('a replayed assertion (same counter) and a stranger\'s key are both refused', async () => {
    const s = await setup();
    const { device } = await registerUser(s);
    const step1 = await s.passkeys.authenticate({ deviceId: 'iphone-1' });
    const assertion = await device.authenticate(step1.options!);
    await s.passkeys.authenticate({ deviceId: 'iphone-1', response: assertion });
    await expect(s.passkeys.authenticate({ deviceId: 'iphone-1', response: assertion })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const stranger = new SimPasskeyDevice();
    await stranger.register(await s.port.registrationOptions({ id: 'x', name: 'x' }));
    const again = await s.passkeys.authenticate({ deviceId: 'iphone-1' });
    const forged = { ...(await stranger.authenticate(again.options!)), credentialId: assertion.credentialId };
    await expect(s.passkeys.authenticate({ deviceId: 'iphone-1', response: forged })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('the signature counter advances in storage after each sign-in', async () => {
    const s = await setup();
    const { device } = await registerUser(s);
    for (let i = 1; i <= 2; i++) {
      const o = await s.passkeys.authenticate({ deviceId: 'iphone-1' });
      await s.passkeys.authenticate({ deviceId: 'iphone-1', response: await device.authenticate(o.options!) });
    }
    const [cred] = await s.repo.listPasskeys((await s.repo.findUserByPhone('+972501234567'))!.partyId);
    expect(cred!.counter).toBe(2);
  });

  it('a new device sign-in records the device and notifies the other devices', async () => {
    const s = await setup();
    const { device } = await registerUser(s);
    const o = await s.passkeys.authenticate({ deviceId: 'ipad-9' });
    await s.passkeys.authenticate({ deviceId: 'ipad-9', response: await device.authenticate(o.options!) });
    const user = (await s.repo.findUserByPhone('+972501234567'))!;
    const devices = await s.repo.listDevices(user.partyId);
    expect(devices.map((d) => d.deviceId).sort()).toEqual(['ipad-9', 'iphone-1']);
    expect(s.passkeys.events.filter((e) => e.type === 'new_device_sign_in').length).toBe(1);
  });
});

// T-0682: the ceremonies are rows, so a registration or sign-in started on one API task finishes on another.
describe('PasskeyService ceremonies across two instances (T-0682)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  async function twoInstances() {
    const clock = fixedClock() as AdvanceableClock;
    const pii = createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) });
    const key = await generateSigningKey();
    // One simulator: it stands in for the WebAuthn library, whose challenge check is not our process state.
    const port = new AuthSimulator(clock);
    const make = () => {
      const repo = new PostgresIdentityRepository(db, pii);
      const otp = new OtpService(port, repo, clock);
      const tokens = new TokenService(repo, key, { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
      return { repo, otp, tokens, passkeys: new PasskeyService(port, repo, tokens, clock, otp) };
    };
    return { clock, a: make(), b: make() };
  }

  async function verifiedOtp(i: { otp: OtpService }, phone: string) {
    const { otpId } = await i.otp.start({ phone, locale: 'en' });
    return (await i.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' })).otpSessionToken!;
  }

  it('a registration started on A completes on B and signs in; a second completion fails', async () => {
    const t = await twoInstances();
    const token = await verifiedOtp(t.a, '+972501110001');
    const device = new SimPasskeyDevice();
    const step1 = await t.a.passkeys.register({ otpSessionToken: token, deviceId: 'iphone-1', deviceName: 'x' });
    const response = await device.register(step1.options!);
    const step2 = await t.b.passkeys.register({ otpSessionToken: token, deviceId: 'iphone-1', deviceName: 'x', response });
    expect(step2.tokens?.accessToken).toBeTruthy();
    await expect(t.a.passkeys.register({ otpSessionToken: token, deviceId: 'iphone-1', deviceName: 'x', response })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a sign-in started on A completes on B; a second completion fails; a stale one is refused', async () => {
    const t = await twoInstances();
    const token = await verifiedOtp(t.a, '+972501110002');
    const device = new SimPasskeyDevice();
    const r1 = await t.a.passkeys.register({ otpSessionToken: token, deviceId: 'iphone-1', deviceName: 'x' });
    await t.a.passkeys.register({ otpSessionToken: token, deviceId: 'iphone-1', deviceName: 'x', response: await device.register(r1.options!) });

    const a1 = await t.a.passkeys.authenticate({ deviceId: 'iphone-1' });
    const assertion = await device.authenticate(a1.options!);
    const a2 = await t.b.passkeys.authenticate({ deviceId: 'iphone-1', response: assertion });
    expect(a2.tokens?.accessToken).toBeTruthy();
    await expect(t.a.passkeys.authenticate({ deviceId: 'iphone-1', response: assertion })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const a3 = await t.a.passkeys.authenticate({ deviceId: 'iphone-1' });
    const stale = await device.authenticate(a3.options!);
    t.clock.advance(60_001);
    await expect(t.b.passkeys.authenticate({ deviceId: 'iphone-1', response: stale })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('keeps the otp-session token out of the ceremony table', async () => {
    const t = await twoInstances();
    const token = await verifiedOtp(t.a, '+972501110003');
    await t.a.passkeys.register({ otpSessionToken: token, deviceId: 'iphone-1', deviceName: 'x' });
    const rows = await db.query(`select * from identity.passkey_ceremony`);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
  });
});

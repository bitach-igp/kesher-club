// TST-AUTH-001 (passkey half) and TST-AUTH-002: enrol a passkey right after OTP; passkeys are the
// default sign-in with device binding; OTP is offered only for recovery.
import { describe, expect, it } from 'vitest';
import { AuthSimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
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

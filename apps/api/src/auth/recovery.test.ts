// TST-AUTH-003: recovery via OTP puts the account in a 24 h restricted state (no money out, no new
// payees, no agent grants) and notifies all bound devices. Within the hold, P2P send is refused
// with RECOVERY_HOLD.
import { describe, expect, it } from 'vitest';
import { AuthSimulator, NotifySimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from './repository.ts';
import { OtpService } from './otp.ts';
import { PasskeyService } from './passkeys.ts';
import { RecoveryService, assertNotRestricted, RECOVERY_HOLD_MS } from './recovery.ts';
import { TokenService, generateSigningKey } from './tokens.ts';

async function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  const notify = new NotifySimulator();
  const otp = new OtpService(port, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  const passkeys = new PasskeyService(port, repo, tokens, clock, otp);
  const recovery = new RecoveryService(repo, otp, passkeys, tokens, notify, clock);
  // An existing member with one passkey on iphone-1 and a push token for that device.
  const { otpId } = await otp.start({ phone: '+972501234567', locale: 'en' });
  const v = await otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const oldDevice = new SimPasskeyDevice();
  const s1 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'old' });
  const s2 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'old', response: await oldDevice.register(s1.options!) });
  const partyId = (await repo.findUserByPhone('+972501234567'))!.partyId;
  await repo.upsertDevice({ partyId, deviceId: 'iphone-1', firstSeenAt: 'x', lastSeenAt: 'x', pushToken: 'ExponentPushToken[old]' });
  return { clock, repo, port, otp, tokens, passkeys, recovery, notify, partyId, oldTokens: s2.tokens! };
}

async function recover(s: Awaited<ReturnType<typeof setup>>, deviceId = 'iphone-new') {
  const { otpId } = await s.otp.start({ phone: '+972501234567', locale: 'en' });
  const v = await s.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'recovery' });
  const device = new SimPasskeyDevice();
  const step1 = await s.recovery.recover({ otpSessionToken: v.otpSessionToken!, deviceId, deviceName: 'new phone' });
  return s.recovery.recover({ otpSessionToken: v.otpSessionToken!, deviceId, deviceName: 'new phone', response: await device.register(step1.options!) });
}

describe('RecoveryService (REQ-AUTH-003)', () => {
  it('recovery enrols a new passkey, drops the old ones, and the tokens carry a 24 h hold', async () => {
    const s = await setup();
    const result = await recover(s);
    expect(result.tokens?.restrictedUntil).toBe(new Date(s.clock.now().getTime() + RECOVERY_HOLD_MS).toISOString());
    const creds = await s.repo.listPasskeys(s.partyId);
    expect(creds.map((c) => c.deviceId)).toEqual(['iphone-new']);
    expect((await s.repo.getRestriction(s.partyId))?.reason).toBe('otp_recovery');
  });

  it('every previously bound device is signed out and notified', async () => {
    const s = await setup();
    await recover(s);
    await expect(s.tokens.verifyAccess(s.oldTokens.accessToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const pushes = s.notify.sent.filter((n) => n.channel === 'push');
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toMatchObject({ to: 'ExponentPushToken[old]', template: 'security.account_recovered', category: 'security' });
  });

  it('within 24 h, money out, new payees and agent grants are refused with RECOVERY_HOLD', async () => {
    const s = await setup();
    const result = await recover(s);
    const principal = await s.tokens.verifyAccess(result.tokens!.accessToken);
    for (const action of ['p2p_send', 'payout', 'new_payee', 'agent_grant', 'card_push_provisioning'] as const) {
      expect(() => assertNotRestricted(principal, action, s.clock.now())).toThrow(expect.objectContaining({ code: 'RECOVERY_HOLD' }));
    }
    expect(() => assertNotRestricted(principal, 'load', s.clock.now())).not.toThrow();
    expect(() => assertNotRestricted(principal, 'card_freeze', s.clock.now())).not.toThrow();
  });

  it('after 24 h the hold lifts and new tokens no longer carry it', async () => {
    const s = await setup();
    const result = await recover(s);
    s.clock.advance(RECOVERY_HOLD_MS + 1);
    const principal = await s.tokens.verifyAccess(result.tokens!.accessToken).catch(() => undefined);
    // The access token itself expired (10 min); refresh gives a clean one.
    expect(principal).toBeUndefined();
    const fresh = await s.tokens.refresh(result.tokens!.refreshToken, 'iphone-new');
    expect(fresh.restrictedUntil).toBeUndefined();
    const p = await s.tokens.verifyAccess(fresh.accessToken);
    expect(() => assertNotRestricted(p, 'p2p_send', s.clock.now())).not.toThrow();
  });

  it('an otp-session verified for registration cannot be used for recovery', async () => {
    const s = await setup();
    const { otpId } = await s.otp.start({ phone: '+972501234567', locale: 'en' });
    const v = await s.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
    await expect(s.recovery.recover({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('recovery for an unknown phone is refused without revealing whether the phone exists', async () => {
    const s = await setup();
    const { otpId } = await s.otp.start({ phone: '+972509999999', locale: 'en' });
    const v = await s.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'recovery' });
    await expect(s.recovery.recover({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: expect.not.stringMatching(/not found|unknown phone/i) });
  });
});

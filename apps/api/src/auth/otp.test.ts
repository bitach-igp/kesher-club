// TST-AUTH-001 (OTP half): register with a phone number verified by a 6-digit OTP, 5-minute expiry,
// 5 attempts, then enrol a passkey (see passkeys.test.ts for the second half).
import { describe, expect, it } from 'vitest';
import { AuthSimulator, SIM_OTP_CODE, SIM_OTP_OUTAGE_PHONE, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from './repository.ts';
import { OtpService } from './otp.ts';

function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  return { clock, repo, port, svc: new OtpService(port, repo, clock) };
}

describe('OtpService (REQ-AUTH-001)', () => {
  it('starts an OTP for an E.164 phone and never returns the code', async () => {
    const { svc } = setup();
    const start = await svc.start({ phone: '+972501234567', locale: 'en' });
    expect(start.attemptsAllowed).toBe(5);
    expect(JSON.stringify(start)).not.toContain(SIM_OTP_CODE);
  });

  it('rejects a malformed phone with VALIDATION_FAILED before touching the provider', async () => {
    const { svc } = setup();
    await expect(svc.start({ phone: '0501234567', locale: 'en' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a wrong code counts down; the right code yields an otp-session bound to the phone and purpose', async () => {
    const { svc } = setup();
    const { otpId } = await svc.start({ phone: '+972501234567', locale: 'en' });
    const wrong = await svc.verify({ otpId, code: '000000', purpose: 'register' });
    expect(wrong).toMatchObject({ verified: false, attemptsLeft: 4 });
    const right = await svc.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
    expect(right.verified).toBe(true);
    const session = await svc.consumeSession(right.otpSessionToken!, 'register');
    expect(session.phone).toBe('+972501234567');
    await expect(svc.consumeSession(right.otpSessionToken!, 'register')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('an otp-session cannot be used for a different purpose (register vs recovery)', async () => {
    const { svc } = setup();
    const { otpId } = await svc.start({ phone: '+972501234567', locale: 'en' });
    const r = await svc.verify({ otpId, code: SIM_OTP_CODE, purpose: 'recovery' });
    await expect(svc.consumeSession(r.otpSessionToken!, 'register')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('expires after 5 minutes and after 5 wrong attempts', async () => {
    const { svc, clock } = setup();
    const a = await svc.start({ phone: '+972501234567', locale: 'en' });
    clock.advance(5 * 60_000 + 1);
    await expect(svc.verify({ otpId: a.otpId, code: SIM_OTP_CODE, purpose: 'register' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const b = await svc.start({ phone: '+972501234567', locale: 'en' });
    for (let i = 0; i < 4; i++) await svc.verify({ otpId: b.otpId, code: '111111', purpose: 'register' });
    await expect(svc.verify({ otpId: b.otpId, code: '111111', purpose: 'register' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('an otp-session itself expires after 10 minutes', async () => {
    const { svc, clock } = setup();
    const { otpId } = await svc.start({ phone: '+972501234567', locale: 'en' });
    const r = await svc.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
    clock.advance(10 * 60_000 + 1);
    await expect(svc.consumeSession(r.otpSessionToken!, 'register')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('throttles OTP starts per phone (3 per 10 minutes) and maps provider outages', async () => {
    const { svc } = setup();
    for (let i = 0; i < 3; i++) await svc.start({ phone: '+972501234567', locale: 'en' });
    await expect(svc.start({ phone: '+972501234567', locale: 'en' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(svc.start({ phone: SIM_OTP_OUTAGE_PHONE, locale: 'en' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

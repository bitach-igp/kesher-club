// TST-AUTH-006: money actions need a step-up (passkey/biometric) younger than 5 minutes. A 6-minute
// old session confirming a P2P send sees STEP_UP_REQUIRED first.
import { describe, expect, it } from 'vitest';
import { AuthSimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { makeRequest } from '../http.ts';
import { InMemoryIdentityRepository } from './repository.ts';
import { OtpService } from './otp.ts';
import { PasskeyService } from './passkeys.ts';
import { STEP_UP_TTL_MS, StepUpService, requireStepUp } from './step-up.ts';
import { TokenService, generateSigningKey } from './tokens.ts';

async function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  const otp = new OtpService(port, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  const passkeys = new PasskeyService(port, repo, tokens, clock, otp);
  const stepUp = new StepUpService(port, repo, clock);
  const { otpId } = await otp.start({ phone: '+972501234567', locale: 'en' });
  const v = await otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const s1 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'x' });
  const s2 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'x', response: await device.register(s1.options!) });
  const principal = await tokens.verifyAccess(s2.tokens!.accessToken);
  return { clock, repo, port, device, stepUp, principal };
}

describe('StepUpService (REQ-AUTH-006)', () => {
  it('a fresh passkey assertion yields a step-up token valid for 5 minutes, bound to the session', async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const step2 = await s.stepUp.complete(s.principal, await s.device.authenticate(step1.options));
    expect(Date.parse(step2.expiresAt) - s.clock.now().getTime()).toBe(STEP_UP_TTL_MS);
    const req = makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': step2.stepUpToken }, principal: s.principal, now: s.clock.now() });
    expect(() => requireStepUp(s.stepUp, req)).not.toThrow();
  });

  it('a session older than 5 minutes without step-up is refused with STEP_UP_REQUIRED', async () => {
    const s = await setup();
    s.clock.advance(6 * 60_000);
    const req = makeRequest({ method: 'POST', path: '/transfers', principal: s.principal, now: s.clock.now() });
    expect(() => requireStepUp(s.stepUp, req)).toThrow(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
  });

  it('a step-up token expires after 5 minutes exactly', async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const { stepUpToken } = await s.stepUp.complete(s.principal, await s.device.authenticate(step1.options));
    const at = (ms: number) => makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': stepUpToken }, principal: s.principal, now: new Date(s.clock.now().getTime() + ms) });
    expect(() => requireStepUp(s.stepUp, at(STEP_UP_TTL_MS))).not.toThrow();
    expect(() => requireStepUp(s.stepUp, at(STEP_UP_TTL_MS + 1))).toThrow(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
  });

  it("a step-up token from another session, or a forged one, is refused", async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const { stepUpToken } = await s.stepUp.complete(s.principal, await s.device.authenticate(step1.options));
    const other = { ...s.principal, sessionId: 'another-session' };
    const req = makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': stepUpToken }, principal: other, now: s.clock.now() });
    expect(() => requireStepUp(s.stepUp, req)).toThrow(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
    const forged = makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': 'su_forged' }, principal: s.principal, now: s.clock.now() });
    expect(() => requireStepUp(s.stepUp, forged)).toThrow(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
  });

  it('a bad or replayed assertion never produces a token', async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const assertion = await s.device.authenticate(step1.options);
    await s.stepUp.complete(s.principal, assertion);
    await expect(s.stepUp.complete(s.principal, assertion)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

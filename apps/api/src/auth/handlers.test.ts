// End-to-end over the HTTP handlers: TST-AUTH-001 sign-up, TST-AUTH-002 sign-in, TST-AUTH-007
// refresh, TST-AUTH-006 step-up, TST-AUTH-003 recovery, all through the operationId handlers.
import { describe, expect, it } from 'vitest';
import { AuthSimulator, NotifySimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock, type PasskeyRegistrationOptions, type PasskeyAuthenticationOptions } from '@kesher/ports';
import { makeRequest, type HttpRequest, type HttpResponse } from '../http.ts';
import { authHandlers, bearerMiddleware } from './handlers.ts';
import { InMemoryIdentityRepository } from './repository.ts';
import { OtpService } from './otp.ts';
import { PasskeyService } from './passkeys.ts';
import { RecoveryService } from './recovery.ts';
import { StepUpService } from './step-up.ts';
import { TokenService, generateSigningKey } from './tokens.ts';

async function app() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  const otp = new OtpService(port, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  const passkeys = new PasskeyService(port, repo, tokens, clock, otp);
  const stepUp = new StepUpService(port, repo, clock);
  const recovery = new RecoveryService(repo, otp, passkeys, tokens, new NotifySimulator(), clock);
  const handlers = authHandlers({ otp, passkeys, recovery, tokens, stepUp });
  const auth = bearerMiddleware(tokens);
  const call = async (op: string, body: unknown, headers: Record<string, string> = {}) => {
    const req: HttpRequest = await auth(makeRequest({ method: 'POST', path: `/${op}`, body, headers, now: clock.now() })).catch((e) => {
      throw e;
    });
    return handlers[op]!(req);
  };
  return { clock, call, stepUp };
}

describe('auth handlers', () => {
  it('sign-up: startOtp → verifyOtp → registerPasskey (options, then response) → tokens', async () => {
    const { call } = await app();
    const start = await call('startOtp', { phone: '+972501234567' });
    expect(start.status).toBe(201);
    const { otpId } = start.body as { otpId: string };
    const verify = await call('verifyOtp', { otpId, code: SIM_OTP_CODE });
    const { otpSessionToken } = verify.body as { otpSessionToken: string };
    const device = new SimPasskeyDevice();
    const step1 = await call('registerPasskey', { deviceId: 'iphone-1', deviceName: 'Noa' }, { authorization: `Bearer ${otpSessionToken}` });
    const options = (step1.body as { options: PasskeyRegistrationOptions }).options;
    const step2 = await call('registerPasskey', { deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(options) }, { authorization: `Bearer ${otpSessionToken}` });
    expect(step2.status).toBe(200);
    expect((step2.body as { tokens: { accessToken: string } }).tokens.accessToken).toBeTruthy();
  });

  it('sign-in, refresh with rotation, and a money call blocked until step-up', async () => {
    const { call, clock, stepUp } = await app();
    const { otpId } = (await call('startOtp', { phone: '+972501234567' })).body as { otpId: string };
    const { otpSessionToken } = (await call('verifyOtp', { otpId, code: SIM_OTP_CODE })).body as { otpSessionToken: string };
    const device = new SimPasskeyDevice();
    const o = (await call('registerPasskey', { deviceId: 'd1' }, { authorization: `Bearer ${otpSessionToken}` })).body as { options: PasskeyRegistrationOptions };
    await call('registerPasskey', { deviceId: 'd1', response: await device.register(o.options) }, { authorization: `Bearer ${otpSessionToken}` });

    const a1 = (await call('authenticatePasskey', { deviceId: 'd1' })).body as { options: PasskeyAuthenticationOptions; recovery: { path: string } };
    expect(a1.recovery.path).toBe('/auth/otp');
    const a2 = (await call('authenticatePasskey', { deviceId: 'd1', response: await device.authenticate(a1.options) })).body as { tokens: { accessToken: string; refreshToken: string } };

    const r = await call('refreshToken', { deviceId: 'd1' }, { authorization: `Bearer ${a2.tokens.refreshToken}` });
    expect(r.status).toBe(200);

    // Step-up over the handlers with the rotated access token, then the guard accepts the header.
    const fresh = (r.body as { accessToken: string }).accessToken;
    const s1 = await call('stepUp', {}, { authorization: `Bearer ${fresh}` });
    const s2 = await call('stepUp', { response: await device.authenticate((s1.body as { options: PasskeyAuthenticationOptions }).options) }, { authorization: `Bearer ${fresh}` });
    const { stepUpToken } = s2.body as { stepUpToken: string };
    expect(stepUpToken).toMatch(/^su_/);
    clock.advance(1000);
    expect(stepUp.isFresh({ partyId: 'x', roles: [], sessionId: 'nope', deviceId: 'd1' }, stepUpToken, clock.now())).toBe(false);

    // Replaying the already-rotated refresh token ends the whole device family (REQ-AUTH-007).
    const replay = await call('refreshToken', { deviceId: 'd1' }, { authorization: `Bearer ${a2.tokens.refreshToken}` });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(call('stepUp', {}, { authorization: `Bearer ${fresh}` })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('an unauthenticated step-up call is 401 and a bad bearer is 401 problem+json', async () => {
    const { call } = await app();
    const res = await call('stepUp', {});
    expect(res.status).toBe(401);
    expect(res.headers?.['content-type']).toBe('application/problem+json');
    await expect(call('stepUp', {}, { authorization: 'Bearer eyJ.not.ajwt' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await call('stepUp', {}, { authorization: 'Bearer otps_opaque' })).status).toBe(401);
  });

  it('T-0120: register, sign-in and refresh refuse a missing or empty deviceId instead of keying on undefined', async () => {
    const { call } = await app();
    const { otpId } = (await call('startOtp', { phone: '+972501234567' })).body as { otpId: string };
    const { otpSessionToken } = (await call('verifyOtp', { otpId, code: SIM_OTP_CODE })).body as { otpSessionToken: string };
    const bearer = { authorization: `Bearer ${otpSessionToken}` };
    const refused = async (res: Promise<HttpResponse>) => expect(await res).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } });
    for (const body of [{}, { deviceId: '' }, { deviceId: 'x'.repeat(129) }, { deviceId: 7 }]) {
      await refused(call('registerPasskey', body, bearer));
      await refused(call('authenticatePasskey', body));
    }
    await refused(call('refreshToken', {}, { authorization: 'Bearer rt_whatever' }));
  });

  it('T-0120: two devices signing in at once each keep their own challenge', async () => {
    const { call } = await app();
    const enrol = async (phone: string, deviceId: string) => {
      const { otpId } = (await call('startOtp', { phone })).body as { otpId: string };
      const { otpSessionToken } = (await call('verifyOtp', { otpId, code: SIM_OTP_CODE })).body as { otpSessionToken: string };
      const device = new SimPasskeyDevice();
      const o = (await call('registerPasskey', { deviceId }, { authorization: `Bearer ${otpSessionToken}` })).body as { options: PasskeyRegistrationOptions };
      await call('registerPasskey', { deviceId, response: await device.register(o.options) }, { authorization: `Bearer ${otpSessionToken}` });
      return device;
    };
    const noa = await enrol('+972501234567', 'noa-phone');
    const dana = await enrol('+15555550101', 'dana-phone');
    const noaStart = (await call('authenticatePasskey', { deviceId: 'noa-phone' })).body as { options: PasskeyAuthenticationOptions };
    const danaStart = (await call('authenticatePasskey', { deviceId: 'dana-phone' })).body as { options: PasskeyAuthenticationOptions };
    const noaDone = await call('authenticatePasskey', { deviceId: 'noa-phone', response: await noa.authenticate(noaStart.options) });
    const danaDone = await call('authenticatePasskey', { deviceId: 'dana-phone', response: await dana.authenticate(danaStart.options) });
    expect([noaDone.status, danaDone.status]).toEqual([200, 200]);
  });
});

// TST-AUTH-001 (REQ-AUTH-001): phone + 6-digit OTP (5 attempts, 5-minute expiry) then immediate passkey enrolment.
// TST-AUTH-002 (REQ-AUTH-002): passkey is the default sign-in; OTP appears only behind "Can't use passkey?".
import { describe, expect, it } from 'vitest';
import type { AuthApi, OtpPurpose } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { fakeAuthenticator } from '../../src/passkeys.ts';
import { memorySession } from '../../src/session.ts';
import { createSignInModel, isE164 } from './signin.model.ts';

class ApiProblem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function fakeAuthApi(opts: { otpCode?: string; attempts?: number; fail?: 'locked' | 'rate_limited'; restricted?: boolean } = {}) {
  const calls: string[] = [];
  let attemptsLeft = opts.attempts ?? 5;
  const tokens = (purpose: OtpPurpose | 'passkey') => ({
    accessToken: `at-${purpose}`,
    refreshToken: 'rt',
    accessExpiresAt: '2026-11-01T09:10:00Z',
    ...(opts.restricted || purpose === 'recovery' ? { restrictedUntil: '2026-11-02T09:00:00Z' } : {}),
  });
  let lastPurpose: OtpPurpose = 'register';
  const api: AuthApi = {
    async startOtp({ phone }) {
      calls.push(`startOtp:${phone}`);
      if (opts.fail === 'rate_limited') throw new ApiProblem('RATE_LIMITED', 429);
      return { otpId: 'otp-1', expiresAt: '2026-11-01T09:05:00Z', attemptsAllowed: 5 };
    },
    async verifyOtp({ otpId, code, purpose }) {
      calls.push(`verifyOtp:${otpId}:${code}:${purpose}`);
      lastPurpose = purpose;
      if (code === (opts.otpCode ?? '123456')) return { verified: true, attemptsLeft, otpSessionToken: 'otp-session' };
      attemptsLeft -= 1;
      if (attemptsLeft <= 0) throw new ApiProblem('RATE_LIMITED', 429);
      return { verified: false, attemptsLeft };
    },
    async registerPasskey({ purpose, response }) {
      calls.push(`registerPasskey:${purpose}:${response ? 'response' : 'options'}`);
      return response ? { credentialId: 'cred-1', tokens: tokens(lastPurpose) } : { options: { challenge: 'c1' } as unknown as Record<string, never> };
    },
    async authenticatePasskey({ response }) {
      calls.push(`authenticatePasskey:${response ? 'response' : 'options'}`);
      if (opts.fail === 'locked') throw new ApiProblem('FORBIDDEN', 403);
      return response ? { tokens: tokens('passkey') } : { options: { challenge: 'a1' } as unknown as Record<string, never> };
    },
  };
  return { api, calls };
}

const now = () => new Date('2026-11-01T09:00:00Z');

function setup(opts: Parameters<typeof fakeAuthApi>[0] = {}, authenticator = fakeAuthenticator()) {
  const { api, calls } = fakeAuthApi(opts);
  const session = memorySession('test-install');
  const router = memoryRouter('/sign-in');
  const model = createSignInModel({ api, authenticator, session, router, now, locale: 'en' });
  return { model, calls, session, router, authenticator };
}

describe('M03 sign-in: passkey first (TST-AUTH-002)', () => {
  it('opens on the passkey prompt with no OTP field, only "Can\'t use passkey?"', () => {
    const { model } = setup();
    expect(model.store.get().mode).toBe('passkey');
    expect(model.store.get().phone).toBe('');
  });

  it('signs in with the passkey in two round trips and lands on home', async () => {
    const { model, calls, session, router, authenticator } = setup();
    await model.signInWithPasskey();
    expect(calls).toEqual(['authenticatePasskey:options', 'authenticatePasskey:response']);
    expect(authenticator.calls).toEqual(['get']);
    expect(session.accessToken()).toBe('at-passkey');
    expect(router.current()).toBe('/');
  });

  it('a cancelled or missing passkey shows the reason and keeps the OTP path behind the recovery link', async () => {
    const cancelled = setup({}, fakeAuthenticator({ get: 'cancel' }));
    await cancelled.model.signInWithPasskey();
    expect(cancelled.model.store.get()).toMatchObject({ mode: 'passkey', error: 'signin.error.cancelled' });
    const none = setup({}, fakeAuthenticator({ get: 'none' }));
    await none.model.signInWithPasskey();
    expect(none.model.store.get()).toMatchObject({ mode: 'passkey', error: 'signin.error.noPasskey' });
    none.model.cantUsePasskey();
    expect(none.model.store.get()).toMatchObject({ mode: 'recovery', error: undefined });
  });

  it('a locked account says so instead of leaking why', async () => {
    const { model } = setup({ fail: 'locked' });
    await model.signInWithPasskey();
    expect(model.store.get().error).toBe('signin.error.locked');
  });

  it('recovery sign-in ends in a passkey enrolment and surfaces the 24 h hold', async () => {
    const { model, session, calls } = setup();
    model.cantUsePasskey();
    model.setPhone('+972501234567');
    await model.sendCode();
    expect(model.store.get()).toMatchObject({ mode: 'verify', purpose: 'recovery', attemptsLeft: 5 });
    model.setCode('123456');
    await model.submitCode();
    expect(model.store.get().mode).toBe('enrol');
    await model.createPasskey();
    expect(calls.slice(-2)).toEqual(['registerPasskey:recovery:options', 'registerPasskey:recovery:response']);
    expect(session.restrictedUntil()).toBe('2026-11-02T09:00:00Z');
    expect(model.store.get()).toMatchObject({ mode: 'done', recoveryHold: true });
  });
});

describe('M03 sign-up: phone + OTP + passkey (TST-AUTH-001)', () => {
  it('validates the phone before sending anything', async () => {
    const { model, calls } = setup();
    model.startSignUp();
    model.setPhone('0501234567');
    await model.sendCode();
    expect(calls).toEqual([]);
    expect(model.store.get().error).toBe('signin.phone.invalid');
    expect(isE164('+972501234567')).toBe(true);
    expect(isE164('+1')).toBe(false);
  });

  it('a correct code enrols a passkey immediately and the account is active', async () => {
    const { model, calls, session, router } = setup();
    model.startSignUp();
    model.setPhone('+972501234567');
    await model.sendCode();
    expect(model.store.get()).toMatchObject({ mode: 'verify', purpose: 'register', expiresAt: '2026-11-01T09:05:00Z' });
    model.setCode('12345');
    await model.submitCode();
    expect(calls.filter((c) => c.startsWith('verifyOtp'))).toEqual([]);
    model.setCode('123456');
    await model.submitCode();
    expect(session.otpSession()).toBe('otp-session');
    expect(model.store.get().mode).toBe('enrol');
    await model.createPasskey();
    expect(calls.slice(-2)).toEqual(['registerPasskey:register:options', 'registerPasskey:register:response']);
    expect(session.accessToken()).toBe('at-register');
    expect(session.otpSession()).toBeUndefined();
    expect(model.store.get()).toMatchObject({ mode: 'done', recoveryHold: false });
    expect(router.current()).toBe('/');
  });

  it('counts down 5 attempts, then locks the number', async () => {
    const { model } = setup({ attempts: 2 });
    model.startSignUp();
    model.setPhone('+972501234567');
    await model.sendCode();
    model.setCode('000000');
    await model.submitCode();
    expect(model.store.get()).toMatchObject({ attemptsLeft: 1, error: 'verify.wrong', code: '' });
    model.setCode('000000');
    await model.submitCode();
    expect(model.store.get()).toMatchObject({ mode: 'locked', error: 'verify.locked' });
  });

  it('an expired code (5 minutes) is refused locally and offers a resend', async () => {
    const { api } = fakeAuthApi();
    let clock = new Date('2026-11-01T09:00:00Z');
    const model = createSignInModel({ api, authenticator: fakeAuthenticator(), session: memorySession('test-install'), router: memoryRouter(), now: () => clock, locale: 'en' });
    model.startSignUp();
    model.setPhone('+972501234567');
    await model.sendCode();
    clock = new Date('2026-11-01T09:05:01Z');
    model.setCode('123456');
    await model.submitCode();
    expect(model.store.get()).toMatchObject({ mode: 'verify', error: 'verify.expired' });
    await model.resendCode();
    expect(model.store.get()).toMatchObject({ error: undefined, attemptsLeft: 5 });
  });

  it('a cancelled passkey creation can be retried without a new OTP', async () => {
    const auth = fakeAuthenticator({ create: 'cancel' });
    const { model, calls } = setup({}, auth);
    model.startSignUp();
    model.setPhone('+972501234567');
    await model.sendCode();
    model.setCode('123456');
    await model.submitCode();
    await model.createPasskey();
    expect(model.store.get()).toMatchObject({ mode: 'enrol', error: 'verify.passkey.failed' });
    expect(calls.filter((c) => c.startsWith('startOtp'))).toHaveLength(1);
  });

  it('rate limiting on OTP start is explained, not retried', async () => {
    const { model } = setup({ fail: 'rate_limited' });
    model.startSignUp();
    model.setPhone('+972501234567');
    await model.sendCode();
    expect(model.store.get()).toMatchObject({ mode: 'signup', error: 'signin.error.rateLimited' });
  });
});

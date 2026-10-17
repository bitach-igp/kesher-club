// M03 sign in / sign up view model (T-0113). Passkey is the default credential (REQ-AUTH-002); the
// OTP path exists for sign-up and recovery only (REQ-AUTH-001, REQ-AUTH-003). Pure over injected deps.
import { errorIs, type AuthApi, type OtpPurpose } from '../../src/api.ts';
import type { CopyKey, Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';
import { NoPasskey, PasskeyCancelled, type Authenticator } from '../../src/passkeys.ts';
import type { Session } from '../../src/session.ts';

export type SignInMode = 'passkey' | 'recovery' | 'signup' | 'verify' | 'locked' | 'enrol' | 'done';

export interface SignInState {
  mode: SignInMode;
  purpose: OtpPurpose;
  phone: string;
  code: string;
  otpId?: string | undefined;
  expiresAt?: string | undefined;
  attemptsLeft: number;
  busy: boolean;
  error?: CopyKey | undefined;
  /** Set after a recovery sign-in: 24 h restriction (REQ-AUTH-003). */
  recoveryHold: boolean;
}

export interface SignInDeps {
  api: AuthApi;
  authenticator: Authenticator;
  session: Session;
  router: Router;
  now: () => Date;
  locale: Locale;
  deviceName?: string | undefined;
  homeHref?: string | undefined;
}

const E164 = /^\+[1-9]\d{6,14}$/;
export const isE164 = (phone: string): boolean => E164.test(phone);

/** Keeps digits and one leading +, so "+972 50-123 4567" becomes E.164 before validation. */
export const normalisePhone = (raw: string): string => {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits.replace(/\+/g, '');
};

const initial: SignInState = { mode: 'passkey', purpose: 'register', phone: '', code: '', attemptsLeft: 0, busy: false, recoveryHold: false };

export interface SignInModel {
  store: Store<SignInState>;
  signInWithPasskey(): Promise<void>;
  cantUsePasskey(): void;
  startSignUp(): void;
  backToPasskey(): void;
  setPhone(phone: string): void;
  setCode(code: string): void;
  sendCode(): Promise<void>;
  resendCode(): Promise<void>;
  submitCode(): Promise<void>;
  createPasskey(): Promise<void>;
}

export function createSignInModel(deps: SignInDeps): SignInModel {
  const store = createStore<SignInState>(initial);
  const home = deps.homeHref ?? '/';

  const fail = (error: CopyKey, extra: Partial<SignInState> = {}) => store.patch({ busy: false, error, ...extra });

  const apiFailure = (e: unknown): CopyKey => {
    if (errorIs(e, { code: 'RATE_LIMITED' }) || errorIs(e, { status: 429 })) return 'signin.error.rateLimited';
    if (errorIs(e, { code: 'FORBIDDEN' }) || errorIs(e, { status: 403 }) || errorIs(e, { status: 423 })) return 'signin.error.locked';
    if (errorIs(e, { code: 'PROVIDER_UNAVAILABLE' }) || errorIs(e, { code: 'FEATURE_OFF' })) return 'common.error.unavailable';
    return 'common.error.generic';
  };

  const finish = (tokens: { accessToken: string; refreshToken: string; accessExpiresAt: string; restrictedUntil?: string }) => {
    deps.session.signIn(tokens);
    store.patch({ mode: 'done', busy: false, error: undefined, recoveryHold: tokens.restrictedUntil !== undefined, code: '' });
    deps.router.replace(home);
  };

  return {
    store,

    async signInWithPasskey() {
      store.patch({ busy: true, error: undefined });
      try {
        const start = await deps.api.authenticatePasskey({});
        if (!start.options) return fail('common.error.generic');
        const response = await deps.authenticator.get(start.options);
        const done = await deps.api.authenticatePasskey({ response });
        if (!done.tokens) return fail('common.error.generic');
        finish(done.tokens);
      } catch (e) {
        if (e instanceof PasskeyCancelled) return fail('signin.error.cancelled');
        if (e instanceof NoPasskey) return fail('signin.error.noPasskey');
        fail(apiFailure(e));
      }
    },

    cantUsePasskey() {
      store.patch({ mode: 'recovery', purpose: 'recovery', error: undefined, code: '' });
    },

    startSignUp() {
      store.patch({ mode: 'signup', purpose: 'register', error: undefined, code: '' });
    },

    backToPasskey() {
      store.set({ ...initial });
    },

    setPhone(phone) {
      store.patch({ phone, error: undefined });
    },

    setCode(code) {
      store.patch({ code: code.replace(/\D/g, '').slice(0, 6), error: undefined });
    },

    async sendCode() {
      const s = store.get();
      const phone = normalisePhone(s.phone);
      if (!isE164(phone)) return fail('signin.phone.invalid');
      store.patch({ busy: true, error: undefined, phone });
      try {
        const start = await deps.api.startOtp({ phone, locale: deps.locale });
        store.patch({ mode: 'verify', busy: false, otpId: start.otpId, expiresAt: start.expiresAt, attemptsLeft: start.attemptsAllowed, code: '' });
      } catch (e) {
        fail(apiFailure(e));
      }
    },

    async resendCode() {
      const s = store.get();
      store.patch({ mode: s.purpose === 'register' ? 'signup' : 'recovery' });
      await this.sendCode();
    },

    async submitCode() {
      const s = store.get();
      if (s.mode !== 'verify' || !s.otpId) return;
      if (s.code.length !== 6) return; // the input only enables submit at 6 digits
      if (s.expiresAt && deps.now().getTime() > Date.parse(s.expiresAt)) return fail('verify.expired', { code: '' });
      store.patch({ busy: true, error: undefined });
      try {
        const r = await deps.api.verifyOtp({ otpId: s.otpId, code: s.code, purpose: s.purpose });
        if (r.verified && r.otpSessionToken) {
          deps.session.setOtpSession(r.otpSessionToken);
          store.patch({ mode: 'enrol', busy: false, code: '' });
          return;
        }
        if (r.attemptsLeft <= 0) return fail('verify.locked', { mode: 'locked', attemptsLeft: 0, code: '' });
        fail('verify.wrong', { attemptsLeft: r.attemptsLeft, code: '' });
      } catch (e) {
        if (errorIs(e, { code: 'RATE_LIMITED' }) || errorIs(e, { status: 429 })) return fail('verify.locked', { mode: 'locked', attemptsLeft: 0, code: '' });
        fail(apiFailure(e), { code: '' });
      }
    },

    async createPasskey() {
      store.patch({ busy: true, error: undefined });
      try {
        const start = await deps.api.registerPasskey(deps.deviceName ? { deviceName: deps.deviceName } : {});
        if (!start.options) return fail('verify.passkey.failed');
        const response = await deps.authenticator.create(start.options);
        const done = await deps.api.registerPasskey({ response });
        if (!done.tokens) return fail('verify.passkey.failed');
        finish(done.tokens);
      } catch (e) {
        if (e instanceof PasskeyCancelled) return fail('verify.passkey.failed');
        fail(apiFailure(e));
      }
    },
  };
}

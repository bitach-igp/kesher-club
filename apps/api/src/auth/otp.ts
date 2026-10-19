// OTP start/verify (T-0110, REQ-AUTH-001; recovery entry for REQ-AUTH-003). The code itself lives
// only inside the AuthPort provider; this service never sees or logs it. A verified OTP becomes a
// short-lived otp-session token bound to the phone and the purpose it was verified for.
import { randomBytes } from 'node:crypto';
import { DomainError } from '@kesher/domain';
import { AuthError, type AuthPort, type Clock } from '@kesher/ports';
import type { IdentityRepository } from './repository.ts';

const E164 = /^\+[1-9]\d{6,14}$/;
const OTP_SESSION_TTL_MS = 10 * 60_000;
const STARTS_PER_WINDOW = 3;
const START_WINDOW_MS = 10 * 60_000;

export type OtpPurpose = 'register' | 'recovery';

export class OtpService {
  private readonly port: AuthPort;
  private readonly repo: IdentityRepository;
  private readonly clock: Clock;
  constructor(
    port: AuthPort,
    repo: IdentityRepository,
    clock: Clock,
  ) {
    this.port = port;
    this.repo = repo;
    this.clock = clock;
  }

  async start(input: { phone: string; locale: 'en' | 'he' }): Promise<{ otpId: string; expiresAt: string; attemptsAllowed: number }> {
    if (!E164.test(input.phone)) throw new DomainError('VALIDATION_FAILED', 'Phone must be E.164');
    const now = this.clock.now();
    const since = new Date(now.getTime() - START_WINDOW_MS).toISOString();
    if ((await this.repo.countOtpStarts(input.phone, since)) >= STARTS_PER_WINDOW) {
      throw new DomainError('RATE_LIMITED', 'Too many codes requested; try again in a few minutes');
    }
    let started;
    try {
      started = await this.port.startOtp(input.phone);
    } catch (e) {
      throw mapAuthError(e);
    }
    await this.repo.recordOtpStart({ otpId: started.otpId, phone: input.phone, startedAt: now.toISOString() });
    return started;
  }

  async verify(input: { otpId: string; code: string; purpose: OtpPurpose }): Promise<{ verified: boolean; attemptsLeft: number; otpSessionToken?: string }> {
    if (!/^\d{6}$/.test(input.code)) throw new DomainError('VALIDATION_FAILED', 'Code is six digits');
    let result;
    try {
      result = await this.port.verifyOtp(input.otpId, input.code);
    } catch (e) {
      throw mapAuthError(e);
    }
    if (!result.verified) return { verified: false, attemptsLeft: result.attemptsLeft };
    const phone = await this.phoneFor(result.otpSessionToken ?? '', input.otpId);
    const token = `otps_${randomBytes(24).toString('base64url')}`;
    await this.repo.saveOtpSession({ token, phone, purpose: input.purpose, expiresAt: new Date(this.clock.now().getTime() + OTP_SESSION_TTL_MS).toISOString() });
    return { verified: true, attemptsLeft: result.attemptsLeft, otpSessionToken: token };
  }

  /** Single use. Throws UNAUTHENTICATED when unknown, used, expired or for another purpose. */
  async consumeSession(token: string, purpose: OtpPurpose): Promise<{ phone: string }> {
    const s = await this.repo.takeOtpSession(token);
    if (!s || s.purpose !== purpose || Date.parse(s.expiresAt) <= this.clock.now().getTime()) {
      throw new DomainError('UNAUTHENTICATED', 'Phone verification missing, used or expired');
    }
    return { phone: s.phone };
  }

  /** The provider proves which phone was verified; the simulator encodes it in its token, Twilio Verify returns it. */
  private async phoneFor(providerToken: string, otpId: string): Promise<string> {
    const m = /(\+[1-9]\d{6,14})$/.exec(providerToken);
    if (m) return m[1]!;
    throw new DomainError('UNAUTHENTICATED', `Provider did not confirm the phone for ${otpId}`);
  }
}

function mapAuthError(e: unknown): Error {
  if (e instanceof AuthError) {
    switch (e.code) {
      case 'PROVIDER_UNAVAILABLE':
        return new DomainError('PROVIDER_UNAVAILABLE', 'SMS provider unavailable');
      case 'OTP_ATTEMPTS_EXHAUSTED':
        return new DomainError('RATE_LIMITED', 'Too many wrong codes; request a new one');
      case 'OTP_EXPIRED':
      case 'OTP_UNKNOWN':
        return new DomainError('UNAUTHENTICATED', 'Code expired or unknown; request a new one');
      default:
        return new DomainError('UNAUTHENTICATED', 'Verification failed');
    }
  }
  return e as Error;
}

// Stateful AuthPort simulator with real ES256 signatures (WebCrypto), so the API's passkey logic is
// exercised end to end without a browser. Deterministic fixtures:
//   phone "+15550000001"      -> PROVIDER_UNAVAILABLE on startOtp (SMS provider outage)
//   every other phone         -> OTP code "246810" (never logged; tests read it from `lastCode`)
//   SimPasskeyDevice           -> an in-memory authenticator that signs challenges and counts.

import { webcrypto as crypto } from 'node:crypto';
import { addMs, type Clock, fixedClock } from './base.ts';
import {
  AuthError,
  type AuthPort,
  type OtpStart,
  type OtpVerify,
  type PasskeyAuthenticationOptions,
  type PasskeyAuthenticationResponse,
  type PasskeyCredential,
  type PasskeyRegistrationOptions,
  type PasskeyRegistrationResponse,
} from './auth.ts';

const OTP_TTL_MS = 5 * 60_000;
const OTP_ATTEMPTS = 5;
export const SIM_OTP_CODE = '246810';
export const SIM_OTP_OUTAGE_PHONE = '+15550000001';
const RP_ID = 'kesher.example';
const ES256: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

const b64u = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

interface OtpState {
  phone: string;
  code: string;
  expiresAt: Date;
  attemptsLeft: number;
}

export class AuthSimulator implements AuthPort {
  private readonly otps = new Map<string, OtpState>();
  private readonly issuedChallenges = new Set<string>();
  private seq = 0;
  /** Test hook: the last OTP code issued (a real adapter never exposes this). */
  lastCode: string | undefined;

  constructor(readonly clock: Clock = fixedClock()) {}

  async startOtp(phoneE164: string): Promise<OtpStart> {
    if (phoneE164 === SIM_OTP_OUTAGE_PHONE) throw new AuthError('PROVIDER_UNAVAILABLE', 'Simulated SMS outage');
    if (!/^\+[1-9]\d{6,14}$/.test(phoneE164)) throw new AuthError('OTP_UNKNOWN', 'Phone must be E.164');
    const otpId = `otp_${++this.seq}`;
    const expiresAt = addMs(this.clock.now(), OTP_TTL_MS);
    this.otps.set(otpId, { phone: phoneE164, code: SIM_OTP_CODE, expiresAt, attemptsLeft: OTP_ATTEMPTS });
    this.lastCode = SIM_OTP_CODE;
    return { otpId, expiresAt: expiresAt.toISOString(), attemptsAllowed: OTP_ATTEMPTS };
  }

  async verifyOtp(otpId: string, code: string): Promise<OtpVerify> {
    const s = this.otps.get(otpId);
    if (!s) throw new AuthError('OTP_UNKNOWN', 'Unknown OTP id');
    if (this.clock.now() > s.expiresAt) {
      this.otps.delete(otpId);
      throw new AuthError('OTP_EXPIRED', 'OTP expired');
    }
    if (s.attemptsLeft <= 0) throw new AuthError('OTP_ATTEMPTS_EXHAUSTED', 'No attempts left');
    s.attemptsLeft -= 1;
    if (code !== s.code) {
      if (s.attemptsLeft === 0) {
        this.otps.delete(otpId);
        throw new AuthError('OTP_ATTEMPTS_EXHAUSTED', 'No attempts left');
      }
      return { verified: false, attemptsLeft: s.attemptsLeft };
    }
    this.otps.delete(otpId);
    return { verified: true, attemptsLeft: s.attemptsLeft, otpSessionToken: `otps_${otpId}_${s.phone}` };
  }

  async registrationOptions(user: { id: string; name: string }): Promise<PasskeyRegistrationOptions> {
    const challenge = this.newChallenge();
    return {
      challenge,
      rpId: RP_ID,
      rpName: 'Kesher Club',
      userId: user.id,
      userName: user.name,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
      ],
      timeoutMs: 60_000,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    };
  }

  async verifyRegistration(options: PasskeyRegistrationOptions, response: PasskeyRegistrationResponse): Promise<PasskeyCredential> {
    this.consumeChallenge(options.challenge, response.clientDataJSON);
    const key = await importKey(response.publicKey);
    const ok = await crypto.subtle.verify(SIGN, key, fromB64u(response.attestation), utf8(options.challenge));
    if (!ok) throw new AuthError('BAD_SIGNATURE', 'Attestation signature invalid');
    return {
      credentialId: response.credentialId,
      publicKey: response.publicKey,
      counter: 0,
      userId: options.userId,
      createdAt: this.clock.now().toISOString(),
    };
  }

  async authenticationOptions(allow: readonly PasskeyCredential[]): Promise<PasskeyAuthenticationOptions> {
    return {
      challenge: this.newChallenge(),
      rpId: RP_ID,
      timeoutMs: 60_000,
      userVerification: 'required',
      allowCredentials: allow.map((c) => ({ id: c.credentialId, type: 'public-key' as const })),
    };
  }

  async verifyAuthentication(
    options: PasskeyAuthenticationOptions,
    response: PasskeyAuthenticationResponse,
    stored: PasskeyCredential,
  ): Promise<{ verified: true; newCounter: number } | { verified: false; reason: string }> {
    if (response.credentialId !== stored.credentialId) return { verified: false, reason: 'credential mismatch' };
    try {
      this.consumeChallenge(options.challenge, response.clientDataJSON);
    } catch (e) {
      return { verified: false, reason: (e as Error).message };
    }
    if (response.counter <= stored.counter && !(response.counter === 0 && stored.counter === 0)) {
      return { verified: false, reason: 'counter replay' };
    }
    const key = await importKey(stored.publicKey);
    const signed = new Uint8Array([...fromB64u(response.authenticatorData), ...utf8(response.clientDataJSON)]);
    const ok = await crypto.subtle.verify(SIGN, key, fromB64u(response.signature), signed);
    return ok ? { verified: true, newCounter: response.counter } : { verified: false, reason: 'bad signature' };
  }

  private newChallenge(): string {
    const c = b64u(crypto.getRandomValues(new Uint8Array(32)));
    this.issuedChallenges.add(c);
    return c;
  }

  private consumeChallenge(challenge: string, clientDataJSON: string): void {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: string; origin?: string };
    if (data.challenge !== challenge || !this.issuedChallenges.has(challenge)) throw new AuthError('CHALLENGE_MISMATCH', 'Challenge unknown or reused');
    if (data.origin !== `https://${RP_ID}` && data.origin !== `https://app.${RP_ID}`) throw new AuthError('CHALLENGE_MISMATCH', 'Origin not allowed');
    this.issuedChallenges.delete(challenge);
  }
}

async function importKey(spkiB64u: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('spki', fromB64u(spkiB64u), ES256, true, ['verify']);
  } catch {
    throw new AuthError('UNSUPPORTED_ALGORITHM', 'Only ES256 keys are accepted');
  }
}

/** An in-memory authenticator for tests and the simulator panel: one key pair, a signature counter. */
export class SimPasskeyDevice {
  private keys: CryptoKeyPair | undefined;
  private counter = 0;
  readonly credentialId = b64u(crypto.getRandomValues(new Uint8Array(16)));

  constructor(readonly origin = `https://${RP_ID}`) {}

  async register(options: PasskeyRegistrationOptions): Promise<PasskeyRegistrationResponse> {
    this.keys = await crypto.subtle.generateKey(ES256, true, ['sign', 'verify']);
    const publicKey = b64u(await crypto.subtle.exportKey('spki', this.keys.publicKey));
    const attestation = b64u(await crypto.subtle.sign(SIGN, this.keys.privateKey, utf8(options.challenge)));
    return { credentialId: this.credentialId, publicKey, clientDataJSON: this.clientData(options.challenge, 'webauthn.create'), attestation, transports: ['internal'] };
  }

  async authenticate(options: PasskeyAuthenticationOptions): Promise<PasskeyAuthenticationResponse> {
    if (!this.keys) throw new Error('register first');
    this.counter += 1;
    const clientDataJSON = this.clientData(options.challenge, 'webauthn.get');
    const authenticatorData = b64u(utf8(`${options.rpId}|uv|${this.counter}`));
    const signed = new Uint8Array([...fromB64u(authenticatorData), ...utf8(clientDataJSON)]);
    const signature = b64u(await crypto.subtle.sign(SIGN, this.keys.privateKey, signed));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData, signature, counter: this.counter };
  }

  /** Test hook: clone the device state onto another "device" (simulates a cloned authenticator). */
  cloneCounterTo(n: number): void {
    this.counter = n;
  }

  private clientData(challenge: string, type: string): string {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin })).toString('base64url');
  }
}

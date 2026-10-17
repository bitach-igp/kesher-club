// AuthPort (REQ-AUTH-001/002/003/006/007): phone OTP and WebAuthn passkeys. The API's auth module
// talks to this port; the live adapter is SimpleWebAuthn + Twilio Verify.

export interface OtpStart {
  otpId: string;
  /** ISO time; 5 minutes after start (REQ-AUTH-001). */
  expiresAt: string;
  attemptsAllowed: number;
}

export interface OtpVerify {
  verified: boolean;
  attemptsLeft: number;
  /** Set only when verified: proves the phone for the next step (passkey registration). */
  otpSessionToken?: string;
}

export interface PasskeyRegistrationOptions {
  challenge: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  /** Allowed algorithms: ES256 (-7) and EdDSA (-8) only; no RS256 (Tab 3 §8 weak-crypto gate). */
  pubKeyCredParams: readonly { type: 'public-key'; alg: -7 | -8 }[];
  timeoutMs: number;
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' };
}

export interface PasskeyRegistrationResponse {
  credentialId: string;
  /** COSE/SPKI public key, base64url. */
  publicKey: string;
  clientDataJSON: string;
  /** Signature over challenge by the new key, base64url (simulator) or attestation object (live). */
  attestation: string;
  transports?: readonly string[];
}

export interface PasskeyCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  userId: string;
  deviceName?: string;
  createdAt: string;
}

export interface PasskeyAuthenticationOptions {
  challenge: string;
  rpId: string;
  timeoutMs: number;
  userVerification: 'required';
  allowCredentials: readonly { id: string; type: 'public-key' }[];
}

export interface PasskeyAuthenticationResponse {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  counter: number;
}

export interface AuthPort {
  startOtp(phoneE164: string): Promise<OtpStart>;
  verifyOtp(otpId: string, code: string): Promise<OtpVerify>;
  registrationOptions(user: { id: string; name: string }): Promise<PasskeyRegistrationOptions>;
  verifyRegistration(options: PasskeyRegistrationOptions, response: PasskeyRegistrationResponse): Promise<PasskeyCredential>;
  authenticationOptions(allow: readonly PasskeyCredential[]): Promise<PasskeyAuthenticationOptions>;
  /** Verifies the assertion against the stored credential; returns the new counter. Replayed counters fail. */
  verifyAuthentication(
    options: PasskeyAuthenticationOptions,
    response: PasskeyAuthenticationResponse,
    stored: PasskeyCredential,
  ): Promise<{ verified: true; newCounter: number } | { verified: false; reason: string }>;
}

export type AuthErrorCode = 'OTP_EXPIRED' | 'OTP_ATTEMPTS_EXHAUSTED' | 'OTP_UNKNOWN' | 'CHALLENGE_MISMATCH' | 'BAD_SIGNATURE' | 'UNSUPPORTED_ALGORITHM' | 'PROVIDER_UNAVAILABLE';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// Passkey registration (T-0110, REQ-AUTH-001) and authentication with device binding (T-0111,
// REQ-AUTH-002). Two-step ceremonies: a call without `response` returns options; the second call
// verifies. Passkeys are the only sign-in; the response carries the recovery entry point as a link.
import { randomUUID } from 'node:crypto';
import { DomainError } from '@kesher/domain';
import type { AuthPort, Clock, PasskeyAuthenticationOptions, PasskeyAuthenticationResponse, PasskeyRegistrationOptions, PasskeyRegistrationResponse } from '@kesher/ports';
import type { Principal } from '../http.ts';
import type { OtpService } from './otp.ts';
import type { IdentityRepository, StoredPasskey } from './repository.ts';
import type { TokenPair, TokenService } from './tokens.ts';

const CEREMONY_TTL_MS = 60_000;

export interface RegisterInput {
  deviceId: string;
  deviceName: string;
  /** New account: the otp-session from verifyOtp(purpose=register or recovery). */
  otpSessionToken?: string;
  /** Existing account adding a device. */
  principal?: Principal;
  response?: PasskeyRegistrationResponse;
  /** Set by RecoveryService: the ceremony re-keys an existing account. */
  recoveryFor?: string;
}

export interface RegisterResult {
  options?: PasskeyRegistrationOptions;
  credentialId?: string;
  tokens?: TokenPair;
}

export interface AuthenticateInput {
  deviceId: string;
  response?: PasskeyAuthenticationResponse;
}

export interface AuthenticateResult {
  options?: PasskeyAuthenticationOptions;
  tokens?: TokenPair;
  /** The only non-passkey path offered (REQ-AUTH-002). */
  recovery: { label: string; path: string };
}

export type AuthEvent = { type: 'new_device_sign_in'; partyId: string; deviceId: string; at: string } | { type: 'passkey_added'; partyId: string; deviceId: string; at: string };

interface PendingCeremony<O> {
  options: O;
  partyId: string;
  issuedAt: number;
}

export class PasskeyService {
  private readonly pendingRegistrations = new Map<string, PendingCeremony<PasskeyRegistrationOptions>>();
  private readonly pendingAuthentications = new Map<string, PendingCeremony<PasskeyAuthenticationOptions>>();
  /** Domain events for notifications (consumed by the outbox / NotifyService). */
  readonly events: AuthEvent[] = [];

  constructor(
    private readonly port: AuthPort,
    private readonly repo: IdentityRepository,
    private readonly tokens: TokenService,
    private readonly clock: Clock,
    private readonly otp?: OtpService,
  ) {}

  async register(input: RegisterInput): Promise<RegisterResult> {
    const now = this.clock.now();
    const ceremonyKey = `${input.deviceId}|${input.otpSessionToken ?? input.principal?.partyId ?? input.recoveryFor ?? ''}`;
    if (!input.response) {
      const partyId = input.recoveryFor ?? input.principal?.partyId ?? `pending:${randomUUID()}`;
      const options = await this.port.registrationOptions({ id: partyId, name: input.principal ? partyId : 'new member' });
      this.pendingRegistrations.set(ceremonyKey, { options, partyId, issuedAt: now.getTime() });
      return { options };
    }
    const pending = this.pendingRegistrations.get(ceremonyKey);
    this.pendingRegistrations.delete(ceremonyKey);
    if (!pending || now.getTime() - pending.issuedAt > CEREMONY_TTL_MS) throw new DomainError('UNAUTHENTICATED', 'Registration ceremony missing or expired');

    let cred;
    try {
      cred = await this.port.verifyRegistration(pending.options, input.response);
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Passkey registration could not be verified');
    }

    let partyId = pending.partyId;
    let roles: readonly string[] = ['member'];
    if (input.recoveryFor) {
      partyId = input.recoveryFor;
      roles = (await this.repo.findUser(partyId))?.roles ?? roles;
    } else if (input.principal) {
      roles = input.principal.roles;
    } else {
      if (!input.otpSessionToken || !this.otp) throw new DomainError('UNAUTHENTICATED', 'Phone verification required');
      const { phone } = await this.otp.consumeSession(input.otpSessionToken, 'register');
      if (await this.repo.findUserByPhone(phone)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'An account with this phone already exists; sign in or recover');
      partyId = randomUUID();
      await this.repo.createUser({ partyId, phone, status: 'active', roles, createdAt: now.toISOString() });
    }

    const stored: StoredPasskey = { credentialId: cred.credentialId, partyId, publicKey: cred.publicKey, counter: cred.counter, deviceId: input.deviceId, deviceName: input.deviceName, createdAt: now.toISOString() };
    await this.repo.addPasskey(stored);
    await this.repo.upsertDevice({ partyId, deviceId: input.deviceId, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString() });
    if (input.principal) this.events.push({ type: 'passkey_added', partyId, deviceId: input.deviceId, at: now.toISOString() });
    const tokens = input.principal ? undefined : await this.tokens.issue({ partyId, deviceId: input.deviceId, roles });
    return { credentialId: cred.credentialId, ...(tokens ? { tokens } : {}) };
  }

  async authenticate(input: AuthenticateInput): Promise<AuthenticateResult> {
    const now = this.clock.now();
    const recovery = { label: "Can't use passkey?", path: '/auth/otp' };
    if (!input.response) {
      // Discoverable credentials: no allow-list, the authenticator picks the resident key.
      const options = await this.port.authenticationOptions([]);
      this.pendingAuthentications.set(input.deviceId, { options, partyId: '', issuedAt: now.getTime() });
      return { options, recovery };
    }
    const pending = this.pendingAuthentications.get(input.deviceId);
    this.pendingAuthentications.delete(input.deviceId);
    if (!pending || now.getTime() - pending.issuedAt > CEREMONY_TTL_MS) throw new DomainError('UNAUTHENTICATED', 'Sign-in ceremony missing or expired');

    const stored = await this.repo.findPasskey(input.response.credentialId);
    if (!stored) throw new DomainError('UNAUTHENTICATED', 'Unknown passkey');
    const user = await this.repo.findUser(stored.partyId);
    if (!user || user.status === 'closed') throw new DomainError('UNAUTHENTICATED', 'Account unavailable');
    const result = await this.port.verifyAuthentication(pending.options, input.response, { credentialId: stored.credentialId, publicKey: stored.publicKey, counter: stored.counter, userId: stored.partyId, createdAt: stored.createdAt });
    if (!result.verified) throw new DomainError('UNAUTHENTICATED', 'Passkey assertion rejected');
    await this.repo.updatePasskeyCounter(stored.credentialId, result.newCounter, now.toISOString());

    const { isNew } = await this.repo.upsertDevice({ partyId: user.partyId, deviceId: input.deviceId, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString() });
    if (isNew) this.events.push({ type: 'new_device_sign_in', partyId: user.partyId, deviceId: input.deviceId, at: now.toISOString() });
    const tokens = await this.tokens.issue({ partyId: user.partyId, deviceId: input.deviceId, roles: user.roles });
    return { tokens, recovery };
  }
}

// Step-up (T-0115, REQ-AUTH-006): a fresh passkey assertion mints a 5-minute step-up token bound to
// the session. Every money handler calls requireStepUp(); the <StepUp/> component (packages/ui)
// drives the ceremony when the API answers STEP_UP_REQUIRED.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import type { AuthPort, Clock, PasskeyAuthenticationOptions, PasskeyAuthenticationResponse } from '@kesher/ports';
import type { HttpRequest, Principal } from '../http.ts';
import type { IdentityRepository } from './repository.ts';

export const STEP_UP_TTL_MS = 5 * 60_000;
const CEREMONY_TTL_MS = 60_000;

export class StepUpService {
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

  async start(principal: Principal): Promise<{ options: PasskeyAuthenticationOptions }> {
    const creds = await this.repo.listPasskeys(principal.partyId);
    const options = await this.port.authenticationOptions(creds.map((c) => ({ credentialId: c.credentialId, publicKey: c.publicKey, counter: c.counter, userId: c.partyId, createdAt: c.createdAt })));
    const now = this.clock.now();
    await this.repo.saveCeremony({ ceremonyId: uuidv7(), kind: 'step_up', key: principal.sessionId, partyId: principal.partyId, options, issuedAt: now.toISOString() }, new Date(now.getTime() - CEREMONY_TTL_MS).toISOString());
    return { options };
  }

  async complete(principal: Principal, response: PasskeyAuthenticationResponse): Promise<{ stepUpToken: string; expiresAt: string }> {
    const now = this.clock.now();
    const pending = await this.repo.takeCeremony('step_up', principal.sessionId, now.toISOString());
    if (!pending || now.getTime() - Date.parse(pending.issuedAt) > CEREMONY_TTL_MS) throw new DomainError('UNAUTHENTICATED', 'Step-up ceremony missing or expired');
    const stored = await this.repo.findPasskey(response.credentialId);
    if (!stored || stored.partyId !== principal.partyId) throw new DomainError('UNAUTHENTICATED', 'Passkey does not belong to this account');
    const result = await this.port.verifyAuthentication(pending.options as PasskeyAuthenticationOptions, response, { credentialId: stored.credentialId, publicKey: stored.publicKey, counter: stored.counter, userId: stored.partyId, createdAt: stored.createdAt });
    if (!result.verified) throw new DomainError('UNAUTHENTICATED', 'Step-up assertion rejected');
    await this.repo.updatePasskeyCounter(stored.credentialId, result.newCounter, now.toISOString());
    const expiresAt = now.getTime() + STEP_UP_TTL_MS;
    const token = `su_${randomBytes(24).toString('base64url')}`;
    await this.repo.putStepUp({ sessionId: principal.sessionId, tokenHash: hash(token), expiresAt: new Date(expiresAt).toISOString() }, now.toISOString());
    return { stepUpToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** True when the token belongs to this session and is younger than 5 minutes at `now`. */
  async isFresh(principal: Principal, token: string | undefined, now: Date): Promise<boolean> {
    if (!token) return false;
    const entry = await this.repo.findStepUp(principal.sessionId);
    if (!entry) return false;
    if (Date.parse(entry.expiresAt) < now.getTime()) {
      await this.repo.deleteStepUp(principal.sessionId);
      return false;
    }
    const a = Buffer.from(entry.tokenHash);
    const b = Buffer.from(hash(token));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** The token is 192 random bits, so an unsalted SHA-256 is enough: the table never holds a usable token. */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Guard for money handlers. Reads X-Step-Up; throws STEP_UP_REQUIRED (401) so the client runs the ceremony. */
export async function requireStepUp(stepUp: StepUpService, req: HttpRequest): Promise<void> {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
  if (!(await stepUp.isFresh(req.principal, req.headers['x-step-up'], req.now))) {
    throw new DomainError('STEP_UP_REQUIRED', 'Confirm with your passkey to continue', { stepUpPath: '/auth/step-up' });
  }
}

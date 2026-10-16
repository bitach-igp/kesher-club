// Step-up (T-0115, REQ-AUTH-006): a fresh passkey assertion mints a 5-minute step-up token bound to
// the session. Every money handler calls requireStepUp(); the <StepUp/> component (packages/ui)
// drives the ceremony when the API answers STEP_UP_REQUIRED.
import { createHmac, randomBytes } from 'node:crypto';
import { DomainError } from '@kesher/domain';
import type { AuthPort, Clock, PasskeyAuthenticationOptions, PasskeyAuthenticationResponse } from '@kesher/ports';
import type { HttpRequest, Principal } from '../http.ts';
import type { IdentityRepository } from './repository.ts';

export const STEP_UP_TTL_MS = 5 * 60_000;
const CEREMONY_TTL_MS = 60_000;

export class StepUpService {
  private readonly pending = new Map<string, { options: PasskeyAuthenticationOptions; issuedAt: number }>();
  /** Session id → token hash + expiry. Bounded by the number of live sessions; entries expire with the token. */
  private readonly issued = new Map<string, { tokenHash: string; expiresAt: number }>();
  private readonly secret = randomBytes(32);

  constructor(
    private readonly port: AuthPort,
    private readonly repo: IdentityRepository,
    private readonly clock: Clock,
  ) {}

  async start(principal: Principal): Promise<{ options: PasskeyAuthenticationOptions }> {
    const creds = await this.repo.listPasskeys(principal.partyId);
    const options = await this.port.authenticationOptions(creds.map((c) => ({ credentialId: c.credentialId, publicKey: c.publicKey, counter: c.counter, userId: c.partyId, createdAt: c.createdAt })));
    this.pending.set(principal.sessionId, { options, issuedAt: this.clock.now().getTime() });
    return { options };
  }

  async complete(principal: Principal, response: PasskeyAuthenticationResponse): Promise<{ stepUpToken: string; expiresAt: string }> {
    const now = this.clock.now();
    const pending = this.pending.get(principal.sessionId);
    this.pending.delete(principal.sessionId);
    if (!pending || now.getTime() - pending.issuedAt > CEREMONY_TTL_MS) throw new DomainError('UNAUTHENTICATED', 'Step-up ceremony missing or expired');
    const stored = await this.repo.findPasskey(response.credentialId);
    if (!stored || stored.partyId !== principal.partyId) throw new DomainError('UNAUTHENTICATED', 'Passkey does not belong to this account');
    const result = await this.port.verifyAuthentication(pending.options, response, { credentialId: stored.credentialId, publicKey: stored.publicKey, counter: stored.counter, userId: stored.partyId, createdAt: stored.createdAt });
    if (!result.verified) throw new DomainError('UNAUTHENTICATED', 'Step-up assertion rejected');
    await this.repo.updatePasskeyCounter(stored.credentialId, result.newCounter, now.toISOString());
    const expiresAt = now.getTime() + STEP_UP_TTL_MS;
    const token = `su_${randomBytes(24).toString('base64url')}`;
    this.issued.set(principal.sessionId, { tokenHash: this.hash(token), expiresAt });
    return { stepUpToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** True when the token belongs to this session and is younger than 5 minutes at `now`. */
  isFresh(principal: Principal, token: string | undefined, now: Date): boolean {
    if (!token) return false;
    const entry = this.issued.get(principal.sessionId);
    if (!entry) return false;
    if (entry.expiresAt < now.getTime()) {
      this.issued.delete(principal.sessionId);
      return false;
    }
    return entry.tokenHash === this.hash(token);
  }

  private hash(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('base64url');
  }
}

/** Guard for money handlers. Reads X-Step-Up; throws STEP_UP_REQUIRED (401) so the client runs the ceremony. */
export function requireStepUp(stepUp: StepUpService, req: HttpRequest): void {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
  if (!stepUp.isFresh(req.principal, req.headers['x-step-up'], req.now)) {
    throw new DomainError('STEP_UP_REQUIRED', 'Confirm with your passkey to continue', { stepUpPath: '/auth/step-up' });
  }
}

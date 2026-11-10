// A member's Apple or Google link (T-0694, REQ-AUTH-004, REQ-AUTH-005). T-0691 signs a member in through an
// ops.external_ref row (entity_type 'member', provider, external_id the IdP subject); this is what writes it, and for
// Apple keeps the refresh token that T-0692 must revoke when the account closes. The token is sealed with the PII
// cipher (AES-256-GCM, the column name as associated data) before it reaches the repository, so no table, log or error
// holds it in clear. Google refresh tokens are out of scope: a token passed for Google is not kept.
// A service only: there is no route yet. Adding a sign-in method needs a fresh step-up, and that check belongs to the
// route card that calls `link`; this service trusts its caller to have made it.
import { DomainError } from '@kesher/domain';
import type { PiiCipher } from '../crypto/pii.ts';
import type { FederatedLinkProvider, IdentityRepository } from './repository.ts';

/** The cipher's associated data: a sealed token only opens in this column. */
export const FEDERATED_TOKEN_COLUMN = 'identity.federated_token.refresh_token_sealed';

const PROVIDERS: readonly FederatedLinkProvider[] = ['apple', 'google'];

export interface SocialLinksDeps {
  identity: IdentityRepository;
  pii: PiiCipher;
  clock: { now(): Date };
}

export class SocialLinks {
  private readonly d: SocialLinksDeps;
  constructor(deps: SocialLinksDeps) {
    this.d = deps;
  }

  /** Links the member to the IdP subject. A second link for the member and provider, or a subject another member holds, is a 409. */
  async link(partyId: string, provider: FederatedLinkProvider, input: { subject: string; refreshToken?: string }): Promise<void> {
    if (!PROVIDERS.includes(provider)) throw new DomainError('VALIDATION_FAILED', 'provider must be apple or google');
    if (typeof input.subject !== 'string' || input.subject.length < 1 || input.subject.length > 255) throw new DomainError('VALIDATION_FAILED', 'subject is required: 1 to 255 characters');
    if (input.refreshToken !== undefined && (typeof input.refreshToken !== 'string' || input.refreshToken.length < 1 || input.refreshToken.length > 4096)) {
      throw new DomainError('VALIDATION_FAILED', 'refreshToken must be 1 to 4096 characters');
    }
    if (!(await this.d.identity.findUser(partyId))) throw new DomainError('NOT_FOUND', 'No such member');

    const result = await this.d.identity.linkFederated({
      partyId,
      provider,
      subject: input.subject,
      ...(provider === 'apple' && input.refreshToken ? { refreshTokenSealed: this.d.pii.seal(input.refreshToken, FEDERATED_TOKEN_COLUMN) } : {}),
      createdAt: this.d.clock.now().toISOString(),
    });
    // The messages name the provider only: never the subject or the token.
    if (result === 'member_already_linked') throw new DomainError('IDEMPOTENCY_CONFLICT', `This member is already linked to ${provider}`);
    if (result === 'subject_taken') throw new DomainError('IDEMPOTENCY_CONFLICT', `This ${provider} identity is already linked to another member`);
  }

  /**
   * The unsealed refresh token, for the revoker only (T-0692); undefined when none is stored. It reads and does not
   * delete: the revoker calls `eraseToken` once it has tried the revoke, whatever the outcome.
   */
  async takeForRevoke(partyId: string, provider: FederatedLinkProvider): Promise<string | undefined> {
    const sealed = await this.d.identity.findFederatedToken(partyId, provider);
    return sealed ? this.d.pii.open(sealed, FEDERATED_TOKEN_COLUMN) : undefined;
  }

  /** Deletes the token row and keeps the link. True when a token was stored. */
  async eraseToken(partyId: string, provider: FederatedLinkProvider): Promise<boolean> {
    return this.d.identity.deleteFederatedToken(partyId, provider);
  }
}

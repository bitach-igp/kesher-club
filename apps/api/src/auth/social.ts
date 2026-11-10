// Sign in with Apple and Google (T-0691, REQ-AUTH-004): offered together or not at all, behind `auth.social.enabled`.
// Passkeys stay the primary sign-in. This route only signs in a member who is already linked to the identity: the app
// sends the identity token it got from Apple or Google, the FederatedIdPPort verifies it (signature, issuer, audience,
// expiry, nonce; no JWT check lives here) and the verified subject is looked up in ops.external_ref
// (entity_type 'member', provider 'apple' | 'google'). An identity nobody is linked to answers NOT_FOUND and creates no
// member. Linking from settings is a later card; until then the link rows are written by support or a test.
// The member gets the same token pair as a passkey sign-in, and a new device raises the same new_device_sign_in event.
import { DomainError, uuidv7 } from '@kesher/domain';
import { FederatedIdPError, type FederatedIdPPort, type FederatedProvider } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { ok, route, type Handler } from '../http.ts';
import type { AuthEvent } from './passkeys.ts';
import type { IdentityRepository } from './repository.ts';
import type { SocialLinks } from './social-links.ts';
import type { TokenPair, TokenService } from './tokens.ts';

export const SOCIAL_FLAG = 'auth.social.enabled';
/** The only providers, in the order they are offered. Never one without the other. */
export const SOCIAL_PROVIDERS: readonly FederatedProvider[] = ['apple', 'google'];

export interface SocialSignInDeps {
  db: Database;
  flags: FeatureFlags;
  /** Resolved per call so a binding that fails to build only fails this feature. */
  port: () => FederatedIdPPort;
  identity: IdentityRepository;
  tokens: TokenService;
  clock: { now(): Date };
  /** The same event list the passkey service fills, so a new device notifies the same way. */
  events: AuthEvent[];
}

export class SocialSignIn {
  private readonly d: SocialSignInDeps;
  constructor(deps: SocialSignInDeps) {
    this.d = deps;
  }

  /** Both providers, or none while the flag is off. */
  async providers(): Promise<{ providers: FederatedProvider[] }> {
    return { providers: (await this.d.flags.isOn(SOCIAL_FLAG)) ? [...SOCIAL_PROVIDERS] : [] };
  }

  async signIn(input: { provider: unknown; idToken: unknown; nonce: unknown; deviceId: unknown }): Promise<{ tokens: TokenPair }> {
    if (!(await this.d.flags.isOn(SOCIAL_FLAG))) throw new DomainError('FEATURE_OFF', 'Sign in with Apple and Google is not available yet');
    const provider = SOCIAL_PROVIDERS.find((p) => p === input.provider);
    if (!provider) throw new DomainError('VALIDATION_FAILED', 'provider must be apple or google');
    if (typeof input.idToken !== 'string' || input.idToken.length < 1 || input.idToken.length > 8192) throw new DomainError('VALIDATION_FAILED', 'idToken is required');
    if (typeof input.nonce !== 'string' || input.nonce.length < 1 || input.nonce.length > 256) throw new DomainError('VALIDATION_FAILED', 'nonce is required: 1 to 256 characters');
    if (typeof input.deviceId !== 'string' || input.deviceId.length < 1 || input.deviceId.length > 128) throw new DomainError('VALIDATION_FAILED', 'deviceId is required: 1 to 128 characters');

    let subject: string;
    try {
      subject = (await this.d.port().verifyIdentityToken(provider, { idToken: input.idToken, nonce: input.nonce })).subject;
    } catch (e) {
      if (!(e instanceof FederatedIdPError)) throw e;
      if (e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'Sign-in with this provider is unavailable; use your passkey');
      if (e.code === 'UNSUPPORTED_PROVIDER') throw new DomainError('VALIDATION_FAILED', 'provider must be apple or google');
      // A bad signature, expired token, wrong audience or wrong nonce all read the same to the caller.
      throw new DomainError('UNAUTHENTICATED', 'Identity token rejected');
    }

    const link = (await this.d.db.query<{ entity_id: string }>(`select entity_id from ops.external_ref where entity_type = 'member' and provider = $1 and external_id = $2`, [provider, subject])).rows[0];
    if (!link) throw new DomainError('NOT_FOUND', 'No member is linked to this identity; sign in with a passkey');
    const user = await this.d.identity.findUser(link.entity_id);
    if (!user || user.status === 'closed') throw new DomainError('UNAUTHENTICATED', 'Account unavailable');

    const at = this.d.clock.now().toISOString();
    const deviceId = input.deviceId;
    const { isNew } = await this.d.identity.upsertDevice({ partyId: user.partyId, deviceId, firstSeenAt: at, lastSeenAt: at });
    if (isNew) this.d.events.push({ type: 'new_device_sign_in', partyId: user.partyId, deviceId, at });
    return { tokens: await this.d.tokens.issue({ partyId: user.partyId, deviceId, roles: user.roles }) };
  }
}

export function socialHandlers(social: SocialSignIn): Record<string, Handler> {
  const signInWithSocial: Handler<{ provider?: unknown; idToken?: unknown; nonce?: unknown; deviceId?: unknown }> = async (req) =>
    ok(await social.signIn({ provider: req.body?.provider, idToken: req.body?.idToken, nonce: req.body?.nonce, deviceId: req.body?.deviceId }));
  return {
    listSocialProviders: route(async () => ok(await social.providers())),
    signInWithSocial: route(signInWithSocial as Handler),
  };
}

export const appleRevokeKey = (partyId: string): string => `closure:${partyId}:apple-revoke`;
export const appleRevokeCaseKey = (partyId: string): string => `apple-revoke:${partyId}`;

export interface SocialTokenRevokerDeps {
  db: Database;
  links: SocialLinks;
  /** Resolved per call so a binding that fails to build only fails this feature. */
  port: () => FederatedIdPPort;
}

/**
 * Account closure revokes the member's Apple refresh token (T-0692, REQ-AUTH-005). Called by ClosureService after the
 * account is closed, never before. It reads the token (T-0694), revokes it under `closure:{partyId}:apple-revoke`, then
 * erases the row. A failed revoke does not block the closure: it opens one ops.case (dedupe `apple-revoke:{partyId}`)
 * and the token is erased anyway, so no usable token outlives the account. A crash between revoke and erase is mended
 * by the next call: the same key makes the revoke a replay, then the erase runs. With no stored token (Google only,
 * a passkey only, an Apple link without a token, or already erased) it does nothing. The token never reaches a log,
 * a case payload or an error: the case carries a failure code only.
 */
export class SocialTokenRevoker {
  private readonly d: SocialTokenRevokerDeps;
  constructor(deps: SocialTokenRevokerDeps) {
    this.d = deps;
  }

  async revokeForClosure(partyId: string, now: Date): Promise<void> {
    let failure: string | undefined;
    try {
      const token = await this.d.links.takeForRevoke(partyId, 'apple');
      if (token === undefined) return;
      await this.d.port().revoke('apple', token, appleRevokeKey(partyId));
    } catch (e) {
      failure = e instanceof FederatedIdPError ? e.code : 'REVOKE_FAILED';
    }
    // The case first: if recording it fails the token stays and a retry tries again; once it is there the token goes.
    if (failure !== undefined) {
      await this.d.db.query(
        `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'apple_revoke_failed', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
        [uuidv7(now), appleRevokeCaseKey(partyId), { partyId, provider: 'apple', failure }, now],
      );
    }
    await this.d.links.eraseToken(partyId, 'apple');
  }
}

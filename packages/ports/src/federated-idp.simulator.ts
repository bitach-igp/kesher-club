// FederatedIdPPort simulator. Fixtures: a code of the form `ok:<subject>[:relay]` succeeds
// (`:relay` yields an Apple private-relay address); `outage` -> PROVIDER_UNAVAILABLE; anything else -> INVALID_CODE.
import { IdempotencyStore, Sequence } from './base.ts';
import { FederatedIdPError, type FederatedAuthorization, type FederatedIdentity, type FederatedIdPPort, type FederatedProvider } from './federated-idp.ts';

const ENDPOINTS: Record<FederatedProvider, string> = {
  apple: 'https://appleid.apple.com/auth/authorize',
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
};

export class FederatedIdPSimulator implements FederatedIdPPort {
  private readonly pendingNonces = new Map<string, string>();
  private readonly revocations = new IdempotencyStore<{ revoked: true; auditRef: string }>();
  private readonly audit = new Sequence('revoke');
  /** Test hook: every revoke call the simulator received. */
  readonly revoked: { provider: FederatedProvider; refreshToken: string }[] = [];

  async authorizationUrl(provider: FederatedProvider, input: { state: string; nonce: string; redirectUri: string }): Promise<FederatedAuthorization> {
    if (!(provider in ENDPOINTS)) throw new FederatedIdPError('UNSUPPORTED_PROVIDER', provider);
    this.pendingNonces.set(input.state, input.nonce);
    const q = new URLSearchParams({ response_type: 'code', state: input.state, nonce: input.nonce, redirect_uri: input.redirectUri, scope: 'openid email name' });
    return { provider, url: `${ENDPOINTS[provider]}?${q}`, state: input.state, nonce: input.nonce };
  }

  async exchangeCode(provider: FederatedProvider, input: { code: string; nonce: string; redirectUri: string }): Promise<FederatedIdentity> {
    if (input.code === 'outage') throw new FederatedIdPError('PROVIDER_UNAVAILABLE', 'Simulated IdP outage');
    const m = /^ok:([a-z0-9_-]+)(:relay)?(:nonce=(\S+))?$/i.exec(input.code);
    if (!m) throw new FederatedIdPError('INVALID_CODE', 'Code not recognised');
    const tokenNonce = m[4] ?? input.nonce;
    if (tokenNonce !== input.nonce) throw new FederatedIdPError('NONCE_MISMATCH', 'id_token nonce does not match');
    const subject = `${provider}:${m[1]}`;
    const relay = provider === 'apple' && Boolean(m[2]);
    return {
      provider,
      subject,
      email: relay ? `${m[1]}@privaterelay.appleid.com` : `${m[1]}@example.com`,
      emailVerified: true,
      isPrivateRelay: relay,
      refreshToken: `rt_${provider}_${m[1]}`,
    };
  }

  async revoke(provider: FederatedProvider, refreshToken: string, idempotencyKey: string): Promise<{ revoked: true; auditRef: string }> {
    return this.revocations.run(idempotencyKey, async () => {
      this.revoked.push({ provider, refreshToken });
      return { revoked: true as const, auditRef: this.audit.next() };
    });
  }
}

// FederatedIdPPort contract (TST-AUTH-004/005 at the port layer).
import { describe, expect, it } from 'vitest';
import { FederatedIdPError, type FederatedIdPPort, type FederatedProvider } from './federated-idp.ts';

export interface FederatedIdPContractOptions {
  /** Codes the sandbox accepts: a plain one and an Apple private-relay one. */
  goodCode: string;
  relayCode: string;
  badCode: string;
  outageCode?: string;
  /** Identity tokens for verifyIdentityToken (T-0691): a good one carrying nonce `n1` per provider, and tokens that must be rejected (wrong audience, expired, bad signature, garbage). */
  identity?: { good: (provider: FederatedProvider) => Promise<string> | string; rejected: () => Promise<string[]> | string[] };
}

export function federatedIdPContract(name: string, make: () => FederatedIdPPort, opts: FederatedIdPContractOptions): void {
  describe(`FederatedIdPPort contract: ${name}`, () => {
    const redirectUri = 'https://app.kesher.example/auth/callback';

    it('builds authorization URLs for both providers with state and nonce', async () => {
      const port = make();
      for (const provider of ['apple', 'google'] as const) {
        const a = await port.authorizationUrl(provider, { state: 's1', nonce: 'n1', redirectUri });
        expect(a.url).toMatch(/^https:\/\//);
        expect(a.url).toContain('state=s1');
        expect(a.url).toContain('nonce=n1');
      }
    });

    it('exchanges a code for a verified identity with a stable subject', async () => {
      const port = make();
      const id = await port.exchangeCode('google', { code: opts.goodCode, nonce: 'n1', redirectUri });
      expect(id.subject).toBeTruthy();
      expect(id.emailVerified).toBe(true);
      const again = await port.exchangeCode('google', { code: opts.goodCode, nonce: 'n1', redirectUri });
      expect(again.subject).toBe(id.subject);
    });

    it('accepts an Apple private-relay email (REQ-AUTH-004)', async () => {
      const id = await make().exchangeCode('apple', { code: opts.relayCode, nonce: 'n1', redirectUri });
      expect(id.isPrivateRelay).toBe(true);
      expect(id.email).toMatch(/@privaterelay\.appleid\.com$/);
    });

    it('rejects an unknown code with a typed error', async () => {
      await expect(make().exchangeCode('apple', { code: opts.badCode, nonce: 'n1', redirectUri })).rejects.toBeInstanceOf(FederatedIdPError);
    });

    it('revokes idempotently and returns an audit reference (REQ-AUTH-005)', async () => {
      const port = make();
      const id = await port.exchangeCode('apple', { code: opts.goodCode, nonce: 'n1', redirectUri });
      const a = await port.revoke('apple', id.refreshToken!, 'rev-1');
      const b = await port.revoke('apple', id.refreshToken!, 'rev-1');
      expect(a.revoked).toBe(true);
      expect(b.auditRef).toBe(a.auditRef);
    });

    if (opts.identity) {
      const identity = opts.identity;
      it('verifies an identity token for both providers: stable subject, nonce checked (T-0691)', async () => {
        const port = make();
        for (const provider of ['apple', 'google'] as const) {
          const idToken = await identity.good(provider);
          const id = await port.verifyIdentityToken(provider, { idToken, nonce: 'n1' });
          expect(id.provider).toBe(provider);
          expect(id.subject).toBeTruthy();
          expect(id.refreshToken).toBeUndefined();
          expect((await port.verifyIdentityToken(provider, { idToken, nonce: 'n1' })).subject).toBe(id.subject);
          await expect(port.verifyIdentityToken(provider, { idToken, nonce: 'other' })).rejects.toMatchObject({ code: 'NONCE_MISMATCH' });
        }
      });

      it('rejects a token for the wrong audience, an expired one, a bad signature and garbage (T-0691)', async () => {
        const port = make();
        const rejected = await identity.rejected();
        expect(rejected.length).toBeGreaterThanOrEqual(3);
        for (const idToken of rejected) {
          for (const provider of ['apple', 'google'] as const) {
            await expect(port.verifyIdentityToken(provider, { idToken, nonce: 'n1' })).rejects.toMatchObject({ code: 'INVALID_CODE' });
          }
        }
      });
    }

    if (opts.outageCode) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().exchangeCode('google', { code: opts.outageCode!, nonce: 'n', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

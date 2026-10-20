// KybPort contract. Every adapter:
// - answers the same question the same way;
// - refuses a malformed identifier with a typed error;
// - returns one screening result per name, in order;
// - carries a provider reference as evidence;
// - returns no personal data beyond the names it was given;
// - surfaces outages as PROVIDER_UNAVAILABLE.
import { describe, expect, it } from 'vitest';
import { KybError, type KybMarket, type KybPort } from './kyb.ts';

export interface KybContractOptions {
  /** An identifier the provider knows as active, with the name it holds. */
  active: { market: KybMarket; identifier: string; name: string };
  /** A name the provider's screening matches on a sanctions list. */
  sanctionedName: string;
  /** An identifier that makes the provider unavailable, where one can be forced. */
  outageIdentifier?: { market: KybMarket; identifier: string };
}

export function kybContract(name: string, make: () => KybPort, opts: KybContractOptions): void {
  describe(`KybPort contract: ${name}`, () => {
    it('finds an active entity by its identifier, with the register\'s name and a reference, the same way twice', async () => {
      const port = make();
      const a = await port.lookupEntity(opts.active);
      expect(a).toMatchObject({ found: true, status: 'active', nameMatches: true });
      expect(a.reference).toBeTruthy();
      expect(await port.lookupEntity(opts.active)).toEqual(a);
    });

    it('answers exempt status with a reference', async () => {
      const s = await make().exemptStatus({ market: opts.active.market, identifier: opts.active.identifier });
      expect(['shown', 'not_found', 'revoked']).toContain(s.status);
      expect(s.reference).toBeTruthy();
    });

    it('refuses a malformed identifier with a typed error', async () => {
      const port = make();
      await expect(port.lookupEntity({ ...opts.active, identifier: 'abc' })).rejects.toBeInstanceOf(KybError);
      await expect(port.exemptStatus({ market: opts.active.market, identifier: '12' })).rejects.toMatchObject({ code: 'INVALID_IDENTIFIER' });
    });

    it('screens names one result each, in order, and a sanctioned name matches with a list, a score and a reference', async () => {
      const names = ['Plain Name Example', opts.sanctionedName];
      const results = await make().screen({ names });
      expect(results.map((r) => r.name)).toEqual(names);
      expect(results[0]!.matches).toEqual([]);
      const hit = results[1]!.matches.find((m) => m.kind === 'sanctions');
      expect(hit).toMatchObject({ list: expect.any(String), reference: expect.any(String) });
      expect(hit!.score).toBeGreaterThan(0);
      expect(hit!.score).toBeLessThanOrEqual(1);
      // Nothing beyond the names given: no date of birth, address or identity number comes back.
      expect(JSON.stringify(results)).not.toMatch(/dob|birth|address|passport|teudat/i);
    });

    if (opts.outageIdentifier) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().lookupEntity({ ...opts.outageIdentifier!, name: 'x' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

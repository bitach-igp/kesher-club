// InsurancePort contract (TST-INSR-001 at the port layer): disclosures travel with every quote.
import { describe, expect, it } from 'vitest';
import { InsuranceError, type InsurancePort } from './insurance.ts';

export interface InsuranceContractOptions {
  product: string;
  outageProduct?: string;
}

export function insuranceContract(name: string, make: () => InsurancePort, opts: InsuranceContractOptions): void {
  describe(`InsurancePort contract: ${name}`, () => {
    const input = { product: opts.product, memberId: 'm1', market: 'IL' as const, startsAt: '2026-11-01T00:00:00Z', days: 30 };

    it('every quote carries the three disclosures and a commission within the premium (REQ-INSR-001)', async () => {
      const q = await make().quote(input);
      expect(q.disclosures.licensedEntity).toBeTruthy();
      expect(q.disclosures.policyWordingUrl).toMatch(/^https:\/\//);
      expect(q.disclosures.commissionDisclosure).toMatch(/commission/i);
      expect(q.premium.minor > 0n).toBe(true);
      expect(q.commission.minor >= 0n && q.commission.minor <= q.premium.minor).toBe(true);
      expect(q.premium.currency).toBe(q.commission.currency);
    });

    it('binds a quote into an active policy idempotently, then cancels once', async () => {
      const port = make();
      const q = await port.quote(input);
      const a = await port.bind(q.quoteId, 'b-1');
      const b = await port.bind(q.quoteId, 'b-1');
      expect(b.policyId).toBe(a.policyId);
      expect(a.status).toBe('active');
      expect(Date.parse(a.endsAt)).toBeGreaterThan(Date.parse(a.startsAt));
      expect(a.certificateUrl).toMatch(/^https:\/\//);
      expect((await port.cancel(a.policyId, 'c-1')).status).toBe('cancelled');
      await expect(port.cancel(a.policyId, 'c-2')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('unknown products, quotes and policies are typed errors', async () => {
      const port = make();
      await expect(port.quote({ ...input, product: 'no-such-product' })).rejects.toBeInstanceOf(InsuranceError);
      await expect(port.bind('nope', 'b-x')).rejects.toBeInstanceOf(InsuranceError);
      await expect(port.getPolicy('nope')).rejects.toBeInstanceOf(InsuranceError);
    });

    if (opts.outageProduct) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().quote({ ...input, product: opts.outageProduct! })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

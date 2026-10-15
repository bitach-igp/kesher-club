// Port contract suite. The simulator runs it on every PR; each live adapter runs it
// nightly against its vendor sandbox. An adapter that fails it cannot be switched on.

import { describe, expect, it } from 'vitest';
import { EsimError, type EsimPort } from './esim.ts';

export function esimContract(name: string, make: () => EsimPort, opts: { failingSku?: string } = {}): void {
  describe(`EsimPort contract: ${name}`, () => {
    it('lists Israel packages with positive data and cost', async () => {
      const pkgs = await make().listPackages('IL');
      expect(pkgs.length).toBeGreaterThan(0);
      for (const p of pkgs) {
        expect(p.dataGb).toBeGreaterThan(0);
        expect(p.cost.minor > 0n).toBe(true);
      }
    });

    it('orders idempotently and returns an install link', async () => {
      const port = make();
      const [pkg] = await port.listPackages('IL');
      const a = await port.order(pkg!.sku, 'idem-1');
      const b = await port.order(pkg!.sku, 'idem-1');
      expect(b).toEqual(a);
      expect(a.installUrl).toMatch(/^https:\/\//);
      expect(a.lpa).toMatch(/^LPA:1\$/);
    });

    it('reports usage within the purchased allowance', async () => {
      const port = make();
      const [pkg] = await port.listPackages('IL');
      const o = await port.order(pkg!.sku, 'idem-2');
      const u = await port.getUsage(o.iccid);
      expect(u.usedMb).toBeGreaterThanOrEqual(0);
      expect(u.totalMb).toBe(pkg!.dataGb * 1024);
    });

    it('top-up is idempotent by key', async () => {
      const port = make();
      const [pkg] = await port.listPackages('IL');
      const o = await port.order(pkg!.sku, 'idem-3');
      const once = await port.topUp(o.iccid, pkg!.sku, 't1');
      const twice = await port.topUp(o.iccid, pkg!.sku, 't1');
      expect(twice.totalMb).toBe(once.totalMb);
    });

    it('rejects unknown SKUs and ICCIDs with typed errors', async () => {
      const port = make();
      await expect(port.order('NOPE', 'idem-4')).rejects.toBeInstanceOf(EsimError);
      await expect(port.getUsage('000')).rejects.toBeInstanceOf(EsimError);
    });

    if (opts.failingSku) {
      it('surfaces provider outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().order(opts.failingSku!, 'idem-5')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

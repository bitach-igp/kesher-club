import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './registry.ts';
import { EsimSimulator } from './esim.simulator.ts';
import type { EsimPort } from './esim.ts';

describe('ProviderRegistry', () => {
  it('fails closed when a capability is not bound', () => {
    const r = new ProviderRegistry();
    expect(() => r.resolve<EsimPort>('esim', 'IL')).toThrow(/not bound/);
  });

  it('switches implementation by binding, with no code change', async () => {
    const r = new ProviderRegistry();
    r.register<EsimPort>('esim', 'simulator', () => new EsimSimulator());
    r.bind({ capability: 'esim', market: 'IL', provider: 'simulator', mode: 'sim' });
    const port = r.resolve<EsimPort>('esim', 'IL');
    expect((await port.listPackages('IL')).length).toBeGreaterThan(0);
    expect(r.bindingFor('esim', 'IL')?.mode).toBe('sim');
  });

  it('refuses to bind a provider that has no adapter', () => {
    const r = new ProviderRegistry();
    expect(() => r.bind({ capability: 'esim', market: 'IL', provider: 'airalo', mode: 'live' })).toThrow(/No adapter/);
  });
});

import { describe, expect, it } from 'vitest';
import type { ClubApi } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { createHubModel, hubView } from './hub.model.ts';

const club: ClubApi = {
  listCatalogue: async () => ({ items: [] }),
  createAddonOrder: async () => {
    throw new Error('unused');
  },
  getCapabilities: async () => ({ features: { 'esim.airalo': true, 'insurance.coverGenius': false }, entitlements: { 'esim.data': { remaining: '3', unit: 'GB', resetsAt: '2026-12-01T00:00:00Z' } } }),
};

describe('M25 hub', () => {
  it('shows entitlements left and marks feature-off add-ons as coming soon', async () => {
    const router = memoryRouter('/club');
    const m = createHubModel({ club, router });
    await m.load();
    expect(m.store.get().entitlements).toEqual([{ key: 'esim.data', remaining: 3, unit: 'GB', resetsAt: '2026-12-01T00:00:00Z' }]);
    expect(m.store.get().addons.map((a) => [a.kind, a.on])).toEqual([
      ['esim', true],
      ['insurance', false],
      ['concierge', false],
    ]);
    m.open('insurance');
    expect(router.current()).toBe('/club');
    m.open('esim');
    expect(router.current()).toBe('/club/esim');
    expect(hubView({ features: {}, entitlements: {} })).toEqual({ entitlements: [], addons: expect.any(Array) });
  });
});

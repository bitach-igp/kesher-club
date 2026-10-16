// TST-ESIM-001 (REQ-ESIM-001): buy, one-tap install (iOS 17.4+ universal link; Android link or QR) and usage.
import { describe, expect, it } from 'vitest';
import type { AddonOrder, CatalogueItem, ClubApi, EsimUsageApi } from '../../src/api.ts';
import { fakeDevice, supportsOneTapInstall } from '../../src/device.ts';
import { recordingOpener } from '../../src/linking.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { createEsimModel, lpaFromInstallUrl, usageView } from './esim.model.ts';

const INSTALL = 'https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA%3A1%24smdp.example%24ABC-123';

const items: CatalogueItem[] = [
  { sku: 'esim-il-5gb-30d', kind: 'esim', title: 'Israel 5 GB / 30 days', price: { minor: '1500', currency: 'USD' }, creditApplies: true },
  { sku: 'esim-il-20gb-30d', kind: 'esim', title: 'Israel 20 GB / 30 days', price: { minor: '3900', currency: 'USD' } },
  { sku: 'ins-travel', kind: 'insurance', title: 'Travel cover', price: { minor: '2500', currency: 'USD' } },
];

function fakeClub(opts: { empty?: boolean; fail?: boolean; fulfil?: 'now' | 'later' } = {}) {
  const orders = new Map<string, AddonOrder>();
  const club: ClubApi = {
    async listCatalogue() {
      if (opts.fail) throw Object.assign(new Error('down'), { code: 'PROVIDER_UNAVAILABLE', status: 503 });
      return { items: opts.empty ? [] : items };
    },
    async createAddonOrder({ sku }, key) {
      const existing = orders.get(key);
      if (existing) return existing;
      const item = items.find((i) => i.sku === sku);
      if (!item) throw Object.assign(new Error('nf'), { code: 'NOT_FOUND', status: 404 });
      const order: AddonOrder = {
        id: `ord-${orders.size + 1}`,
        sku,
        price: item.price,
        creditApplied: item.creditApplies ? item.price : { minor: '0', currency: item.price.currency },
        state: opts.fulfil === 'later' ? 'fulfilling' : 'fulfilled',
        ...(opts.fulfil === 'later' ? {} : { fulfilment: { iccid: '8997200000012345678', installUrl: INSTALL } }),
      };
      orders.set(key, order);
      return order;
    },
    async getCapabilities() {
      return { features: { 'esim.airalo': true }, entitlements: { 'esim.data': { remaining: '5', unit: 'GB', resetsAt: '2026-12-01T00:00:00Z' } } };
    },
  };
  const esim: EsimUsageApi = { getUsage: async (iccid) => ({ iccid, usedMb: 4200, totalMb: 5120, expiresAt: '2026-11-05T09:00:00Z' }) };
  return { club, esim, orders };
}

const now = () => new Date('2026-11-01T09:00:00Z');

function setup(clubOpts: Parameters<typeof fakeClub>[0] = {}, device = fakeDevice()) {
  const { club, esim, orders } = fakeClub(clubOpts);
  const opener = recordingOpener();
  const router = memoryRouter('/club/esim');
  let n = 0;
  const model = createEsimModel({ club, esim, device, opener, router, now, newKey: () => `key-${++n}` });
  return { model, orders, opener, router, device };
}

describe('M26 plans', () => {
  it('lists only eSIM plans, with the monthly credit applied to the covered plan', async () => {
    const { model } = setup();
    await model.loadPlans();
    const s = model.store.get();
    expect(s.plans.map((p) => p.sku)).toEqual(['esim-il-5gb-30d', 'esim-il-20gb-30d']);
    expect(s.plans[0]).toMatchObject({ dataGb: 5, days: 30, covered: true });
    expect(s.credit).toEqual({ remaining: 5, unit: 'GB' });
    expect(s.status).toBe('ready');
  });

  it('a phone without eSIM support sees the not-capable state and no buy button', async () => {
    const { model } = setup({}, fakeDevice({ esimCapable: false }));
    await model.loadPlans();
    expect(model.store.get().status).toBe('notCapable');
  });

  it('empty and outage states are distinct', async () => {
    const empty = setup({ empty: true });
    await empty.model.loadPlans();
    expect(empty.model.store.get().status).toBe('empty');
    const down = setup({ fail: true });
    await down.model.loadPlans();
    expect(down.model.store.get()).toMatchObject({ status: 'error', error: 'common.error.unavailable' });
  });
});

describe('M27 buy and install (TST-ESIM-001)', () => {
  it('buys with one idempotency key per checkout and lands on install with the one-tap link', async () => {
    const { model, orders, router } = setup();
    await model.loadPlans();
    model.select('esim-il-5gb-30d');
    expect(model.store.get().checkout).toMatchObject({ total: { minor: 0n, currency: 'USD' }, creditApplied: true });
    await model.buy();
    await model.buy(); // double tap
    expect([...orders.keys()]).toEqual(['key-1']);
    expect(model.store.get().order).toMatchObject({ state: 'fulfilled', iccid: '8997200000012345678', installUrl: INSTALL });
    expect(router.current()).toBe('/club/esim/install');
  });

  it('one-tap install opens the OS eSIM sheet on iOS 17.4+ and Android; older iOS gets the QR + code fallback', async () => {
    const { model, opener } = setup();
    await model.loadPlans();
    model.select('esim-il-5gb-30d');
    await model.buy();
    expect(model.store.get().install).toMatchObject({ oneTap: true, lpa: 'LPA:1$smdp.example$ABC-123', steps: 'install.steps.ios' });
    await model.installOneTap();
    expect(opener.opened).toEqual([INSTALL]);
    expect(supportsOneTapInstall({ platform: 'ios', osVersion: '17.3', esimCapable: true })).toBe(false);
    expect(supportsOneTapInstall({ platform: 'ios', osVersion: '18.0', esimCapable: true })).toBe(true);
    expect(supportsOneTapInstall({ platform: 'android', osVersion: '14', esimCapable: true })).toBe(true);
    const old = setup({}, fakeDevice({ osVersion: '17.3' }));
    await old.model.loadPlans();
    old.model.select('esim-il-20gb-30d');
    await old.model.buy();
    expect(old.model.store.get().install).toMatchObject({ oneTap: false, lpa: 'LPA:1$smdp.example$ABC-123' });
    await old.model.copyActivationCode();
    expect(old.device.copied).toEqual(['LPA:1$smdp.example$ABC-123']);
    expect(lpaFromInstallUrl('https://example.com/no-lpa')).toBeUndefined();
  });

  it('a plan still being provisioned shows the preparing state, and install help routes to the help hub', async () => {
    const { model, router } = setup({ fulfil: 'later' });
    await model.loadPlans();
    model.select('esim-il-5gb-30d');
    await model.buy();
    expect(model.store.get()).toMatchObject({ order: { state: 'fulfilling' }, install: undefined });
    model.installFailed();
    expect(router.current()).toBe('/help');
  });
});

describe('M28 usage', () => {
  it('shows a data meter, days left, and low-data / expiring / expired states', async () => {
    const { model } = setup();
    await model.loadUsage('8997200000012345678');
    expect(model.store.get().usage).toMatchObject({ remainingGb: 0.9, totalGb: 5, pctLeft: 18, daysLeft: 4, low: true, expiring: false, expired: false });
    expect(usageView({ iccid: 'x', usedMb: 100, totalMb: 1024, expiresAt: '2026-11-03T08:00:00Z' }, now())).toMatchObject({ daysLeft: 2, expiring: true, low: false });
    expect(usageView({ iccid: 'x', usedMb: 1024, totalMb: 1024, expiresAt: '2026-12-01T00:00:00Z' }, now())).toMatchObject({ pctLeft: 0, expired: true });
    expect(usageView({ iccid: 'x', usedMb: 0, totalMb: 1024, expiresAt: '2026-10-31T00:00:00Z' }, now())).toMatchObject({ daysLeft: 0, expired: true });
  });

  it('top up goes back to plans for the same ICCID', async () => {
    const { model, router } = setup();
    await model.loadUsage('8997200000012345678');
    model.topUp();
    expect(router.current()).toBe('/club/esim?iccid=8997200000012345678');
  });
});

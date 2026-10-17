// Card view model (T-0408): not yet issued, the frozen banner, locked-by-funder reasons, a shipped
// physical card with tracking, activation, and freeze-and-replace for a lost card. KYC paths live in
// (auth)/kyc.model.test.ts.
import { describe, expect, it } from 'vitest';
import type { Card, CardsApi, ShipTo } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { addressProblem, controlRows, createCardModel, EMPTY_ADDRESS, lockedReasons, primaryCard, shippingView, statusBanner } from './card.model.ts';

const problem = (code: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(code), { code, status, ...extra });
const controls = (over: Partial<Card['controls']> = {}): Card['controls'] => ({ blockedMccs: [], atm: false, online: true, agentPurchases: { mode: 'off' }, ...over });
const virtual = (over: Partial<Card> = {}): Card => ({ id: 'v1', type: 'virtual', status: 'active', last4: '0001', controls: controls(), lockedByFunder: [], tokens: [], ...over });
const physical = (over: Partial<Card> = {}): Card => ({ id: 'p1', type: 'physical', status: 'inactive', last4: '0002', controls: controls(), lockedByFunder: [], tokens: [], shipping: { trackingUrl: 'https://track.example/p1', pinSet: false }, ...over });

function fakeCards(initial: Card[], opts: { stepUpFor?: Set<string>; wrongLast4?: boolean } = {}) {
  const cards = new Map(initial.map((c) => [c.id, c]));
  const calls: string[] = [];
  const stepUpNeeded = (op: string) => {
    if (opts.stepUpFor?.has(op)) throw problem('STEP_UP_REQUIRED', 401);
  };
  const api: CardsApi = {
    async listCards() {
      calls.push('list');
      return { items: [...cards.values()] };
    },
    async getCard(id) {
      return cards.get(id)!;
    },
    async setStatus(id, status, _key, reason) {
      calls.push(`status:${id}:${status}:${reason ?? ''}`);
      if (status !== 'frozen') stepUpNeeded('status');
      const c = { ...cards.get(id)!, status, tokens: cards.get(id)!.tokens.map((t) => ({ ...t, status: status === 'frozen' ? ('suspended' as const) : status === 'closed' ? ('deleted' as const) : ('active' as const) })) };
      cards.set(id, c);
      return c;
    },
    async updateControls(id, patch) {
      calls.push(`controls:${id}`);
      const c = cards.get(id)!;
      const locked = Object.keys(patch).filter((k) => c.lockedByFunder.includes(k));
      if (locked.length) throw problem('FORBIDDEN', 403, { lockedByFunder: locked });
      const next = { ...c, controls: { ...c.controls, ...(patch as Partial<Card['controls']>) } };
      cards.set(id, next);
      return next;
    },
    async orderPhysical(shipTo: ShipTo) {
      calls.push(`order:${shipTo.country}`);
      if ([...cards.values()].some((c) => c.type === 'physical' && c.status !== 'closed')) throw problem('IDEMPOTENCY_CONFLICT', 409);
      const c = physical({ id: `p${cards.size + 1}` });
      cards.set(c.id, c);
      return c;
    },
    async activate(id, last4) {
      calls.push(`activate:${id}:${last4}`);
      stepUpNeeded('activate');
      if (opts.wrongLast4 || last4 !== cards.get(id)!.last4) throw problem('VALIDATION_FAILED', 422);
      const c = { ...cards.get(id)!, status: 'active' as const, shipping: { ...cards.get(id)!.shipping, pinSet: true, activatedAt: '2026-11-05T10:00:00Z' } };
      cards.set(id, c);
      return c;
    },
    async detailsToken() {
      stepUpNeeded('details');
      return { token: 'sdt_x', expiresAt: '2026-11-01T09:01:00Z' };
    },
    async startProvisioning(_id, wallet, deviceId) {
      calls.push(`provision:${wallet}:${deviceId}`);
      stepUpNeeded('provision');
      if (deviceId === 'dup') throw problem('IDEMPOTENCY_CONFLICT', 409, { reason: 'ALREADY_PROVISIONED' });
      return { encryptedPassData: 'e', activationData: 'a', ephemeralPublicKey: 'k' };
    },
  };
  return { api, calls, cards };
}
const make = (initial: Card[], opts: Parameters<typeof fakeCards>[1] = {}, deviceId = 'iphone-1') => {
  const f = fakeCards(initial, opts);
  const router = memoryRouter('/card');
  let n = 0;
  const model = createCardModel({ cards: f.api, router, newKey: () => `k${++n}`, deviceId: () => deviceId });
  return { ...f, router, model };
};

describe('card home (M20)', () => {
  it('with no card yet it shows the not-issued state and sends the member to verify', async () => {
    const { model, router } = make([]);
    await model.load();
    expect(model.store.get().mode).toBe('none');
    model.goVerify();
    expect(router.current()).toBe('/kyc');
  });

  it('picks the live card first and shows the frozen banner; freezing needs no step-up and pauses the tokens', async () => {
    const { model, calls } = make([virtual({ tokens: [{ wallet: 'apple', status: 'active', deviceId: 'iphone-1' }] }), physical({ id: 'p0', status: 'closed' })]);
    await model.load();
    expect(model.selected()?.id).toBe('v1');
    expect(statusBanner(model.selected()!)).toBeUndefined();
    await model.freeze();
    expect(model.selected()).toMatchObject({ status: 'frozen', tokens: [{ status: 'suspended' }] });
    expect(statusBanner(model.selected()!)).toEqual({ key: 'card.banner.frozen', tone: 'danger' });
    expect(calls).toContain('status:v1:frozen:');
    expect(primaryCard([virtual({ status: 'frozen' }), physical({ status: 'active' })])?.id).toBe('p1');
  });

  it('unfreezing, details and wallet provisioning surface the passkey step-up instead of an error, then succeed', async () => {
    const { model } = make([virtual({ status: 'frozen' })], { stepUpFor: new Set(['status', 'details']) });
    await model.load();
    await model.unfreeze();
    expect(model.store.get()).toMatchObject({ needsStepUp: true, busy: false, error: undefined });
    expect(model.selected()?.status).toBe('frozen');
    model.stepUpDone();
    expect(await model.showDetails()).toBeUndefined();
    expect(model.store.get().needsStepUp).toBe(true);
    const ok = make([virtual()]);
    await ok.model.load();
    expect(await ok.model.showDetails()).toEqual({ token: 'sdt_x', expiresAt: '2026-11-01T09:01:00Z' });
    await ok.model.addToWallet('apple');
    expect(ok.model.store.get()).toMatchObject({ notice: 'card.wallet.added', payload: { encryptedPassData: 'e' } });
    expect(ok.calls).toContain('provision:apple:iphone-1');
    const dup = make([virtual()], {}, 'dup');
    await dup.model.load();
    await dup.model.addToWallet('google');
    expect(dup.model.store.get()).toMatchObject({ notice: 'card.wallet.already', payload: undefined });
  });
});

describe('controls (M21)', () => {
  it('lists every control with the funder lock and a reason; a member change on a locked key is refused with the reason, others save', async () => {
    const card = virtual({ controls: controls({ dailyLimit: { minor: '50000', currency: 'ILS' }, blockedMccs: ['7995'] }), lockedByFunder: ['dailyLimit', 'blockedMccs'] });
    const rows = controlRows(card, 'en');
    expect(rows.map((r) => [r.key, r.value, r.locked])).toEqual([
      ['atm', false, false],
      ['online', true, false],
      ['dailyLimit', '₪500.00', true],
      ['monthlyLimit', '', false],
      ['blockedMccs', '7995', true],
      ['allowedCountries', '', false],
      ['agentPurchases', 'off', true],
    ]);
    expect(lockedReasons(card)).toEqual([{ key: 'dailyLimit', reason: 'card.locked.hint' }, { key: 'blockedMccs', reason: 'card.locked.hint' }]);
    const { model } = make([card]);
    await model.load();
    await model.setLimit('dailyLimit', { minor: '1', currency: 'ILS' });
    expect(model.store.get().error).toBe('card.locked.refused');
    expect(model.selected()?.controls.dailyLimit).toEqual({ minor: '50000', currency: 'ILS' });
    await model.setToggle('atm', true);
    expect(model.store.get()).toMatchObject({ notice: 'card.controls.saved', error: undefined });
    expect(model.selected()?.controls.atm).toBe(true);
  });
});

describe('physical card: order, shipping and activation (M22, M24)', () => {
  it('validates the address in form order (a US address needs a state), orders once, and shows tracking until activation', async () => {
    const { model, calls } = make([virtual()]);
    await model.load();
    expect(addressProblem(EMPTY_ADDRESS)).toEqual({ field: 'name', key: 'card.physical.required' });
    expect(addressProblem({ ...EMPTY_ADDRESS, name: 'Dana', line1: '1 Main', city: 'Brooklyn', postalCode: '11201', country: 'US' })).toEqual({ field: 'region', key: 'card.physical.required' });
    await model.orderPhysical();
    expect(model.store.get().fieldError).toEqual({ field: 'name', key: 'card.physical.required' });
    expect(calls.filter((c) => c.startsWith('order'))).toEqual([]);
    model.setAddress({ name: 'Noa', line1: 'Herzl 12', city: 'Jerusalem', postalCode: '9100000', country: 'IL' });
    await model.orderPhysical();
    expect(model.store.get()).toMatchObject({ notice: 'card.physical.ordered', address: EMPTY_ADDRESS });
    const p = model.selected()!;
    expect(p.type).toBe('physical');
    expect(shippingView(p)).toEqual({ shipped: true, trackingUrl: 'https://track.example/p1', activated: false, pinSet: false });
    expect(statusBanner(p)).toEqual({ key: 'card.banner.inactive', tone: 'info' });
    model.setAddress({ name: 'Noa', line1: 'Herzl 12', city: 'Jerusalem', postalCode: '9100000', country: 'IL' });
    await model.orderPhysical();
    expect(model.store.get().error).toBe('card.physical.exists');
  });

  it('activation takes exactly four digits, refuses the wrong ones, and records the PIN as set without ever holding it', async () => {
    const { model, calls } = make([physical()]);
    await model.load();
    model.setLast4('12ab3');
    expect(model.store.get().last4).toBe('123');
    await model.activate();
    expect(model.store.get().error).toBe('card.activate.wrong');
    expect(calls.filter((c) => c.startsWith('activate'))).toEqual([]);
    model.setLast4('0009');
    await model.activate();
    expect(model.store.get().error).toBe('card.activate.wrong');
    model.setLast4('0002');
    await model.activate();
    expect(model.store.get()).toMatchObject({ notice: 'card.activate.done', last4: '', error: undefined });
    expect(shippingView(model.selected()!)).toEqual({ shipped: true, trackingUrl: 'https://track.example/p1', activated: true, pinSet: true });
    expect(JSON.stringify(model.store.get())).not.toMatch(/"pin"|\d{13,19}/);
  });
});

describe('lost or stolen (M23)', () => {
  it('closes the card, removes its tokens, and takes the member straight to the replacement order for a physical card', async () => {
    const { model, router, calls } = make([physical({ status: 'active', tokens: [{ wallet: 'google', status: 'active', deviceId: 'pixel-1' }] }), virtual()]);
    await model.load();
    expect(model.selected()?.id).toBe('p1');
    await model.reportLost('stolen');
    expect(calls).toContain('status:p1:closed:stolen');
    expect(model.store.get().cards.find((c) => c.id === 'p1')).toMatchObject({ status: 'closed', tokens: [{ status: 'deleted' }] });
    expect(model.store.get()).toMatchObject({ notice: 'card.lost.done', mode: 'ready', selectedId: 'v1' });
    expect(router.current()).toBe('/card/physical');
    // The replacement goes through now that the old card is closed.
    model.setAddress({ name: 'Noa', line1: 'Herzl 12', city: 'Jerusalem', postalCode: '9100000', country: 'IL' });
    await model.orderPhysical();
    expect(model.store.get().notice).toBe('card.physical.ordered');
  });

  it('a lost virtual card is closed in place; with nothing left the screen returns to not-issued', async () => {
    const { model, router } = make([virtual()]);
    await model.load();
    await model.reportLost('lost');
    expect(model.store.get()).toMatchObject({ mode: 'none', notice: 'card.lost.done' });
    expect(router.current()).toBe('/card');
  });
});

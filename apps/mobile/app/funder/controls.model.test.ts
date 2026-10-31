// T-0412 P09 the funder sets a member's card controls (TST-CRD-005 at the screen): a funder patch names only the keys
// it sets, which the API then locks for the member; a category is all its codes, and the member's own refusals stay;
// "Hand back" releases a key; a retry of the same change keeps its key and a new change takes a new one; freezing
// needs no passkey and unfreezing does; refusals read as sentences.
import { describe, expect, it } from 'vitest';
import type { Card, CardControlsPatch, CardsApi } from '../../src/api.ts';
import { COPY } from '../../src/i18n.ts';
import { BLOCKABLE, createControlsModel, isBlocked, refusal, withCategory, withCountry } from './controls.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const CARD: Card = {
  id: 'c1',
  type: 'virtual',
  status: 'active',
  last4: '4242',
  controls: { atm: true, online: true, blockedMccs: ['5411'], agentPurchases: { mode: 'off' } },
  lockedByFunder: [],
  tokens: [],
} as unknown as Card;

type Call = { op: 'controls'; patch: CardControlsPatch; key: string } | { op: 'status'; status: string; key: string };

/** A fake card API: applies patches the way the server does, locking the keys a funder names. */
function setup(script: { fail?: Error[] } = {}) {
  let card: Card = structuredClone(CARD);
  const calls: Call[] = [];
  const fail = [...(script.fail ?? [])];
  let n = 0;
  const cards: Pick<CardsApi, 'getCard' | 'updateControls' | 'setStatus'> = {
    async getCard(id) {
      expect(id).toBe('c1');
      return card;
    },
    async updateControls(_id, patch, key) {
      calls.push({ op: 'controls', patch, key });
      const f = fail.shift();
      if (f) throw f;
      const { release = [], ...set } = patch;
      const keys = Object.keys(set);
      card = { ...card, controls: { ...card.controls, ...set } as Card['controls'], lockedByFunder: [...new Set([...card.lockedByFunder.filter((k) => !release.includes(k)), ...keys])] };
      return card;
    },
    async setStatus(_id, status, key) {
      calls.push({ op: 'status', status, key });
      const f = fail.shift();
      if (f) throw f;
      card = { ...card, status };
      return card;
    },
  };
  const model = createControlsModel({ cards, newKey: () => `key-${++n}-0000` }, 'c1');
  return { model, calls, card: () => card };
}

describe('T-0412 P09 funder card controls', () => {
  it('a funder patch names only the keys it sets, and the API locks those for the member', async () => {
    const { model, calls } = setup();
    await model.load();
    await model.setToggle('atm', false);
    await model.setCategory('gambling', true);
    await model.setCountry('IL', true);
    expect(calls.map((c) => c.op === 'controls' && Object.keys(c.patch))).toEqual([['atm'], ['blockedMccs'], ['allowedCountries']]);
    // The member's own refusal of 5411 stays; the category is all four of its codes.
    expect(calls[1]).toMatchObject({ patch: { blockedMccs: ['5411', ...BLOCKABLE.gambling] } });
    const s = model.store.get();
    expect(s.card?.lockedByFunder).toEqual(['atm', 'blockedMccs', 'allowedCountries']);
    expect(isBlocked(s.card!, 'gambling')).toBe(true);
    expect(s.notice).toBe('card.controls.saved');
  });

  it('a category lets through once any code is missing; unblocking keeps the codes the member refused', () => {
    const half = { ...CARD, controls: { ...CARD.controls, blockedMccs: ['7995'] } } as Card;
    expect(isBlocked(half, 'gambling')).toBe(false);
    expect(withCategory(['5411', ...BLOCKABLE.alcohol], 'alcohol', false)).toEqual(['5411']);
  });

  it('a country list never goes empty; Anywhere clears it', async () => {
    expect(withCountry(undefined, 'US', true)).toEqual(['US']);
    expect(withCountry(['IL', 'US'], 'IL', false)).toEqual(['US']);
    expect(withCountry(['IL'], 'IL', false)).toBe('empty');
    const { model, calls } = setup();
    await model.load();
    await model.setCountry('IL', true);
    await model.setCountry('IL', false);
    expect(model.store.get().error).toBe('controls.countries.empty');
    expect(calls).toHaveLength(1);
    await model.anywhere();
    expect(calls[1]).toMatchObject({ patch: { allowedCountries: null } });
  });

  it('Hand back releases a key to the member, and says so', async () => {
    const { model, calls } = setup();
    await model.load();
    await model.setToggle('online', false);
    await model.release('online');
    expect(calls[1]).toMatchObject({ op: 'controls', patch: { release: ['online'] } });
    expect(model.store.get().card?.lockedByFunder).toEqual([]);
    expect(model.store.get().card?.controls.online).toBe(false);
    expect(model.store.get().notice).toBe('controls.released');
  });

  it('a retry of the same change keeps its key; the next change takes a new one', async () => {
    const { model, calls } = setup({ fail: [new Problem('PROVIDER_UNAVAILABLE', 503)] });
    await model.load();
    await model.setToggle('online', false);
    expect(model.store.get().error).toBe('common.error.unavailable');
    await model.setToggle('online', false);
    await model.setToggle('online', true);
    expect(calls.map((c) => c.key)).toEqual(['key-1-0000', 'key-1-0000', 'key-2-0000']);
  });

  it('freezing needs no passkey; unfreezing asks for it, then retries with the same key', async () => {
    const freeze = setup();
    await freeze.model.load();
    await freeze.model.freeze();
    expect(freeze.model.store.get()).toMatchObject({ needsStepUp: false, notice: 'controls.frozen', card: { status: 'frozen' } });

    const { model, calls } = setup({ fail: [new Problem('STEP_UP_REQUIRED', 401)] });
    await model.load();
    await model.unfreeze();
    expect(model.store.get()).toMatchObject({ needsStepUp: true, busy: false });
    model.stepUpDone();
    await model.unfreeze();
    expect(model.store.get()).toMatchObject({ needsStepUp: false, notice: 'controls.unfrozen', card: { status: 'active' } });
    expect(calls).toEqual([
      { op: 'status', status: 'active', key: 'key-1-0000' },
      { op: 'status', status: 'active', key: 'key-1-0000' },
    ]);
  });

  it('refusals read as sentences', async () => {
    expect(refusal(new Problem('NOT_FOUND', 404))).toBe('controls.error.notFound');
    expect(refusal(new Problem('FORBIDDEN', 403))).toBe('controls.error.forbidden');
    expect(refusal(new Problem('VALIDATION_FAILED', 422))).toBe('controls.error.closed');
    expect(refusal(new Problem('FEATURE_OFF', 404))).toBe('common.error.unavailable');
    expect(refusal(new Error('boom'))).toBe('common.error.generic');
    for (const k of ['controls.error.notFound', 'controls.error.forbidden', 'controls.error.closed', 'controls.countries.empty'] as const) for (const locale of ['en', 'he'] as const) expect(COPY[locale][k]).toMatch(/\.$/);
    const never = () => Promise.reject(new Error('not called'));
    const gone = createControlsModel({ cards: { getCard: () => Promise.reject(new Problem('NOT_FOUND', 404)), updateControls: never, setStatus: never }, newKey: () => 'k-00000000' }, 'c1');
    await gone.load();
    expect(gone.store.get()).toMatchObject({ mode: 'error', error: 'controls.error.notFound' });
  });
});

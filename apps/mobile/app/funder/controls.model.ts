// P09 a member's card, set by the funder (T-0412, REQ-CRD-005). From P06 the funder opens one of the member's cards and
// sets online, ATM, where it works and which categories it refuses, and can freeze it. Every key the funder sets is
// locked for the member, who sees the reason in M21; "Hand back" releases a key to the member. A retry of the same
// change keeps its Idempotency-Key, so a timeout or a passkey prompt never turns one tap into two changes; a new change
// takes a new key. Freezing needs no passkey; unfreezing does, as it does for the member.
import { errorIs, type Card, type CardControlsPatch, type CardsApi } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

/** The controls P09 sets. Limits and agent purchases have screens of their own. */
export type FunderKey = 'online' | 'atm' | 'allowedCountries' | 'blockedMccs';
export const FUNDER_KEYS: readonly FunderKey[] = ['online', 'atm', 'allowedCountries', 'blockedMccs'];

/** Categories a funder can refuse, as the merchant category codes the network sends. */
export const BLOCKABLE = {
  gambling: ['7800', '7801', '7802', '7995'],
  alcohol: ['5813', '5921'],
  tobacco: ['5993'],
  adult: ['5967', '7273'],
} as const satisfies Record<string, readonly string[]>;
export type Blockable = keyof typeof BLOCKABLE;
export const BLOCKABLE_ORDER: readonly Blockable[] = ['gambling', 'alcohol', 'tobacco', 'adult'];

/** Countries the screen offers; "anywhere" is no list at all. */
export const COUNTRIES = ['IL', 'US'] as const;
export type Country = (typeof COUNTRIES)[number];

export interface ControlsState {
  mode: 'loading' | 'ready' | 'error';
  card?: Card | undefined;
  busy: boolean;
  needsStepUp: boolean;
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
}

export interface ControlsDeps {
  cards: Pick<CardsApi, 'getCard' | 'updateControls' | 'setStatus'>;
  newKey: () => string;
}

/** Whether every code of a category is refused; one missing code lets the category through. */
export const isBlocked = (card: Card, c: Blockable): boolean => BLOCKABLE[c].every((m) => card.controls.blockedMccs.includes(m));

/** The refused codes with one category added or taken away; codes the member refused on their own stay. */
export function withCategory(blocked: readonly string[], c: Blockable, block: boolean): string[] {
  const codes: readonly string[] = BLOCKABLE[c];
  return block ? [...new Set([...blocked, ...codes])] : blocked.filter((m) => !codes.includes(m));
}

/** Where the card works with one country switched; switching off the last one is refused, not "nowhere". */
export function withCountry(allowed: readonly string[] | null | undefined, country: Country, on: boolean): string[] | 'empty' {
  const now = allowed ?? [];
  const next = on ? [...new Set([...now, country])] : now.filter((c) => c !== country);
  return next.length ? next : 'empty';
}

/** A refusal as a sentence the funder can act on. */
export function refusal(e: unknown): CopyKey {
  if (errorIs(e, { code: 'NOT_FOUND' })) return 'controls.error.notFound';
  if (errorIs(e, { code: 'FORBIDDEN' })) return 'controls.error.forbidden';
  if (errorIs(e, { code: 'VALIDATION_FAILED' })) return 'controls.error.closed';
  if (errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { code: 'PROVIDER_UNAVAILABLE' }) || errorIs(e, { status: 503 })) return 'common.error.unavailable';
  return 'common.error.generic';
}

export interface ControlsModel {
  store: Store<ControlsState>;
  load(): Promise<void>;
  setToggle(key: 'online' | 'atm', on: boolean): Promise<void>;
  setCategory(c: Blockable, block: boolean): Promise<void>;
  setCountry(country: Country, on: boolean): Promise<void>;
  /** No country list: the card works anywhere. */
  anywhere(): Promise<void>;
  /** Hand a key back to the member: it stays as set, and they may change it. */
  release(key: FunderKey): Promise<void>;
  freeze(): Promise<void>;
  /** Asks for the passkey; after the sheet, `stepUpDone` and tap again, with the same key. */
  unfreeze(): Promise<void>;
  stepUpDone(): void;
}

export function createControlsModel(deps: ControlsDeps, cardId: string): ControlsModel {
  const store = createStore<ControlsState>({ mode: 'loading', busy: false, needsStepUp: false });
  // One key per distinct change, kept until it succeeds: a retry is the same request to the server.
  const pending = new Map<string, string>();
  const keyFor = (change: string) => {
    let k = pending.get(change);
    if (!k) pending.set(change, (k = deps.newKey()));
    return k;
  };

  const run = async (change: string, call: (key: string) => Promise<Card>, notice: CopyKey) => {
    if (store.get().busy) return;
    store.patch({ busy: true, error: undefined, notice: undefined });
    try {
      const card = await call(keyFor(change));
      pending.delete(change);
      store.patch({ card, busy: false, notice });
    } catch (e) {
      if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return store.patch({ busy: false, needsStepUp: true });
      store.patch({ busy: false, error: refusal(e) });
    }
  };
  const patch = (body: CardControlsPatch, notice: CopyKey = 'card.controls.saved') => run(`controls:${JSON.stringify(body)}`, (key) => deps.cards.updateControls(cardId, body, key), notice);
  const card = () => store.get().card;

  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        store.patch({ mode: 'ready', card: await deps.cards.getCard(cardId) });
      } catch (e) {
        store.patch({ mode: 'error', error: refusal(e) });
      }
    },

    setToggle: (key, on) => patch({ [key]: on }),

    async setCategory(c, block) {
      const current = card();
      if (current) await patch({ blockedMccs: withCategory(current.controls.blockedMccs, c, block) });
    },

    async setCountry(country, on) {
      const current = card();
      if (!current) return;
      const next = withCountry(current.controls.allowedCountries, country, on);
      if (next === 'empty') return store.patch({ error: 'controls.countries.empty', notice: undefined });
      await patch({ allowedCountries: next });
    },

    // The contract's `null` clears the list; the generated type does not spell it, so it is cast once, here.
    anywhere: () => patch({ allowedCountries: null } as unknown as CardControlsPatch),

    release: (key) => patch({ release: [key] }, 'controls.released'),

    freeze: () => run('status:frozen', (key) => deps.cards.setStatus(cardId, 'frozen', key), 'controls.frozen'),

    unfreeze: () => run('status:active', (key) => deps.cards.setStatus(cardId, 'active', key), 'controls.unfrozen'),

    stepUpDone() {
      store.patch({ needsStepUp: false });
    },
  };
}

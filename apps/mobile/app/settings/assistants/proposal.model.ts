// M35 assistant proposal (T-1012, REQ-AGT-006): what an assistant proposed, in the member's own words
// ("Send $50.00 to Dana"), from which purse, what the recipient receives, which assistant, and how long is
// left. The assistant's note and name are its words, shown as text and set apart, never parsed (REQ-AGT-007).
// Approve runs the passkey step-up and the approval once per attempt key; decline needs no step-up. An
// expired or decided proposal offers neither.
import { format, fromWire, type Money } from '@kesher/domain';
import { errorIs, type ApprovedIntent, type MemberIntent, type PayApi, type ProposalsApi, type TransferPreview } from '../../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../../src/i18n.ts';
import { createStore, type Store } from '../../../src/model.ts';

export interface Problem {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

export interface ProposalState {
  mode: 'loading' | 'ready' | 'error';
  /** Waiting proposals, soonest deadline first. */
  items: MemberIntent[];
  /** The one opened. */
  current?: MemberIntent | undefined;
  /** What a send would land as, for the opened proposal. */
  preview?: TransferPreview | undefined;
  attemptKey?: string | undefined;
  busy: boolean;
  needsStepUp: boolean;
  approved?: ApprovedIntent | undefined;
  error?: Problem | undefined;
  notice?: Problem | undefined;
}

export interface ProposalDeps {
  proposals: ProposalsApi;
  pay?: Pick<PayApi, 'preview'>;
  newKey: () => string;
  now: () => Date;
}

export const fmt = (m: Money, locale: Locale): string => format(m, intlLocale(locale));
const amountOf = (p: MemberIntent): Money | undefined => (p.amount ? fromWire(p.amount) : undefined);

/** Who the money goes to, as the member would say it: a roster name, else the masked phone. Never parsed. */
export const recipientText = (p: MemberIntent): string => p.untrusted.recipientName ?? p.recipient?.phoneMasked ?? '';

/** The proposal in the member's words. */
export function sentence(p: MemberIntent, locale: Locale): { key: CopyKey; vars: Record<string, string> } {
  const amount = amountOf(p);
  const a = amount ? fmt(amount, locale) : '';
  switch (p.kind) {
    case 'send':
      return { key: 'proposal.send', vars: { amount: a, to: recipientText(p) } };
    case 'load':
      return { key: 'proposal.load', vars: { amount: a } };
    case 'card_purchase':
      return { key: 'proposal.cardPurchase', vars: { amount: a } };
    default:
      return { key: 'proposal.limitChange', vars: {} };
  }
}

/** Pending and inside its deadline as of now: only then can it be approved or declined. */
export const actionable = (p: MemberIntent | undefined, now: Date): boolean => !!p && p.status === 'pending' && Date.parse(p.expiresAt) > now.getTime();

/** "3 h 12 min" or "12 min" left; undefined once it has passed. */
export function timeLeft(p: MemberIntent, now: Date): { h: number; m: number } | undefined {
  const ms = Date.parse(p.expiresAt) - now.getTime();
  if (ms <= 0) return undefined;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}

export function problemFor(e: unknown): Problem | 'stepUp' | 'gone' {
  if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return 'stepUp';
  if (errorIs(e, { code: 'NOT_FOUND' })) return 'gone';
  if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' })) return { key: 'proposal.decided' };
  if (errorIs(e, { code: 'LIMIT_EXCEEDED' })) return { key: 'proposal.limit' };
  if (errorIs(e, { code: 'INSUFFICIENT_FUNDS' })) return { key: 'proposal.insufficient' };
  if (errorIs(e, { code: 'AGENT_NOT_ALLOWED' })) return { key: 'proposal.revoked' };
  if (errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 503 })) return { key: 'common.error.unavailable' };
  return { key: 'common.error.generic' };
}

export interface ProposalModel {
  store: Store<ProposalState>;
  load(): Promise<void>;
  open(id: string): Promise<void>;
  approve(): Promise<void>;
  decline(): Promise<void>;
  stepUpDone(): void;
}

export function createProposalModel(deps: ProposalDeps): ProposalModel {
  const store = createStore<ProposalState>({ mode: 'loading', items: [], busy: false, needsStepUp: false });
  /** A proposal that is no longer waiting leaves the list; the opened one shows its new state. */
  const settled = (p: MemberIntent) => store.set((s) => ({ ...s, current: p, items: s.items.filter((x) => x.id !== p.id || p.status === 'pending') }));

  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const { items } = await deps.proposals.list('pending');
        store.patch({ mode: 'ready', items: [...items].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)) });
      } catch (e) {
        const p = problemFor(e);
        store.patch({ mode: 'error', error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
      }
    },

    async open(id) {
      store.patch({ current: undefined, preview: undefined, approved: undefined, attemptKey: undefined, error: undefined, notice: undefined, needsStepUp: false });
      try {
        const current = await deps.proposals.get(id);
        store.patch({ current, mode: 'ready' });
        if (current.kind === 'send' && current.recipient && current.amount && deps.pay && actionable(current, deps.now())) {
          const preview = await deps.pay.preview({ toPartyId: current.recipient.partyId, amount: current.amount }).catch(() => undefined);
          store.patch({ preview });
        }
      } catch (e) {
        const p = problemFor(e);
        store.patch({ error: p === 'gone' ? { key: 'proposal.gone' } : typeof p === 'string' ? { key: 'common.error.generic' } : p });
      }
    },

    async approve() {
      const s = store.get();
      if (s.busy || s.approved || !s.current || !actionable(s.current, deps.now())) return;
      const key = s.attemptKey ?? deps.newKey();
      store.patch({ busy: true, attemptKey: key, error: undefined, notice: undefined });
      try {
        // A load proposal names no funding method; the member's card pays, as on Add money.
        const approved = await deps.proposals.approve(s.current.id, key, s.current.kind === 'load' ? { method: 'card' } : undefined);
        store.patch({ busy: false, needsStepUp: false, approved, attemptKey: undefined });
        settled({ ...s.current, status: 'approved' });
      } catch (e) {
        const p = problemFor(e);
        if (p === 'stepUp') return store.patch({ busy: false, needsStepUp: true });
        if (p === 'gone') return store.patch({ busy: false, error: { key: 'proposal.gone' } });
        store.patch({ busy: false, error: p });
      }
    },

    async decline() {
      const s = store.get();
      if (s.busy || !s.current || !actionable(s.current, deps.now())) return;
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        const declined = await deps.proposals.decline(s.current.id, deps.newKey());
        store.patch({ busy: false, notice: { key: 'proposal.declined' } });
        settled(declined);
      } catch (e) {
        const p = problemFor(e);
        store.patch({ busy: false, error: p === 'gone' ? { key: 'proposal.gone' } : typeof p === 'string' ? { key: 'common.error.generic' } : p });
      }
    },

    stepUpDone() {
      store.patch({ needsStepUp: false });
    },
  };
}

// Pay view model for M12 pay home, M13 recipient, M14 amount, M15 confirm, M16 request, M17 split,
// M18 request inbox and M19 QR (T-0508). Screens pass the flow's state through route params, so each
// screen builds its own model; the confirm sheet mints its Idempotency-Key once and keeps it through a
// step-up and a retry, so a double tap or a flaky network is one transfer (REQ-PAY-005). Server
// refusals become copy with the server's own numbers (the remaining amount, the available balance);
// nothing here recomputes a limit. Request notes and recipient names are data, rendered as written.
// Currencies (T-0516, REQ-PAY-006/007): M14 offers the purses the member holds and opens on one with
// money in it; M15 shows what the recipient receives from the server's preview (T-0518), which prices
// exactly as the send does, and the sent sheet shows both amounts from the transfer itself.
import { format, fromWire, money, toWire, type Currency, type Money } from '@kesher/domain';
import { errorIs, type Account, type MoneyWire, type PayApi, type PaymentRequest, type Split, type Transfer, type TransferPreview } from '../../src/api.ts';
import type { Camera, Contacts } from '../../src/device.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import { href, type Router } from '../../src/navigation.ts';

export type PayMode = 'loading' | 'ready' | 'error';
export interface Problem {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

export interface PayState {
  mode: PayMode;
  accounts: Account[];
  requests: PaymentRequest[];
  currency: Currency;
  recipient: string;
  amountText: string;
  note: string;
  busy: boolean;
  needsStepUp: boolean;
  /** Fixed for the life of one confirm sheet; cleared when the sheet closes or the send completes. */
  confirmKey?: string | undefined;
  result?: Transfer | undefined;
  /** M15: the server's preview of what the recipient receives; refreshed each time the sheet opens. */
  preview?: TransferPreview | undefined;
  previewing: boolean;
  split: { totalText: string; participants: string[]; created?: Split | undefined };
  qrAmountText: string;
  error?: Problem | undefined;
  notice?: Problem | undefined;
}

export interface PayDeps {
  pay: PayApi;
  router: Router;
  newKey: () => string;
  now: () => Date;
  /** The signed-in member's party id, for "yourself" checks, the inbox sides and the QR code. */
  me: string;
  camera?: Camera | undefined;
  contacts?: Contacts | undefined;
  /** Resolves a picked contact to a member id (the API's lookup, when the contract gains one); none → unresolved. */
  resolveContact?: (phone: string) => Promise<string | undefined>;
  locale?: Locale;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const QR_SCHEME = 'kesher://pay';
export const NOTE_MAX = 140;

// ---- pure helpers -----------------------------------------------------------------------------

/** "50", "49.90", "1,200.5" → minor units; anything else is a problem key. */
export function parseAmount(text: string, currency: Currency): { amount: Money } | { problem: CopyKey } {
  const cleaned = text.replace(/[,\s₪$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { problem: 'pay.amount.invalid' };
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  if (minor <= 0n) return { problem: 'pay.amount.zero' };
  return { amount: money(minor, currency) };
}

export const isMemberId = (v: string): boolean => UUID.test(v.trim());

/**
 * The signed-in member's party id, read from the access token's `sub` for display and "yourself" checks
 * only. The server verifies the token; the app trusts nothing else in it.
 */
export function partyIdOf(accessToken: string | undefined): string | undefined {
  const payload = accessToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const sub = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub;
    return typeof sub === 'string' && isMemberId(sub) ? sub : undefined;
  } catch {
    return undefined;
  }
}

export function buildQr(me: string, amount?: Money): string {
  const q = new URLSearchParams({ to: me });
  if (amount) {
    q.set('amount', amount.minor.toString());
    q.set('currency', amount.currency);
  }
  return `${QR_SCHEME}?${q.toString()}`;
}

/** Parses a scanned code; the member id must be a UUID and the amount, when present, a positive integer. */
export function parseQr(payload: string): { to: string; amount?: Money } | undefined {
  if (!payload.startsWith(`${QR_SCHEME}?`)) return undefined;
  const q = new URLSearchParams(payload.slice(QR_SCHEME.length + 1));
  const to = q.get('to') ?? '';
  if (!isMemberId(to)) return undefined;
  const minor = q.get('amount');
  const currency = q.get('currency');
  if (minor === null) return { to };
  if (!/^\d+$/.test(minor) || BigInt(minor) <= 0n || (currency !== 'USD' && currency !== 'ILS')) return undefined;
  return { to, amount: money(BigInt(minor), currency) };
}

/** Equal shares for the others; the requester keeps the remainder (the agorot nobody can split). */
export function splitPreview(total: Money, others: number): { share: Money; yours: Money } | undefined {
  if (others < 1) return undefined;
  const share = total.minor / BigInt(others + 1);
  if (share <= 0n) return undefined;
  return { share: money(share, total.currency), yours: money(total.minor - share * BigInt(others), total.currency) };
}

export interface InboxView {
  owed: PaymentRequest[];
  asked: PaymentRequest[];
  history: PaymentRequest[];
}

/** Open requests I owe, open requests I asked for, and everything settled, newest first. */
export function inboxView(items: readonly PaymentRequest[], me: string): InboxView {
  const byNewest = (a: PaymentRequest, b: PaymentRequest) => (a.createdAt < b.createdAt ? 1 : -1);
  const open = items.filter((r) => r.status === 'open');
  return {
    owed: open.filter((r) => r.payerPartyId === me).sort(byNewest),
    asked: open.filter((r) => r.requesterPartyId === me).sort(byNewest),
    history: items.filter((r) => r.status !== 'open').sort(byNewest),
  };
}

export function available(accounts: readonly Account[], currency: Currency): Money {
  const a = accounts.find((x) => x.currency === currency);
  return a ? fromWire(a.available) : money(0n, currency);
}

/** Shekels first: the club's home currency. */
export const PURSES: readonly Currency[] = ['ILS', 'USD'];
export interface PurseOption {
  currency: Currency;
  available: Money;
}

/** M14: the purses the member holds, each with what is available in it. */
export function purseOptions(accounts: readonly Account[]): PurseOption[] {
  return PURSES.filter((c) => accounts.some((a) => a.currency === c)).map((c) => ({ currency: c, available: available(accounts, c) }));
}

/**
 * The purse M14 opens on: the chosen one when it covers `need`, else the first purse that does, else the
 * chosen one (the balance line then says what is missing). `need` is at least one agora or cent.
 */
export function defaultPurse(accounts: readonly Account[], current: Currency, need = 1n): Currency {
  const covers = (c: Currency) => available(accounts, c).minor >= (need > 0n ? need : 1n);
  if (covers(current)) return current;
  return purseOptions(accounts).find((o) => covers(o.currency))?.currency ?? current;
}

/** The recipient's side when it lands in another currency (a preview or a transfer); undefined when nothing converts. */
export function convertedTo(x: { amount: MoneyWire; received?: MoneyWire | undefined } | undefined): MoneyWire | undefined {
  return x?.received && x.received.currency !== x.amount.currency ? x.received : undefined;
}

/** Server refusals as copy with the server's numbers. */
export function problemFor(e: unknown, locale: Locale): Problem | 'stepUp' {
  const err = e as { code?: string; status?: number; remaining?: string; currency?: string; limitedBy?: string; available?: string };
  if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return 'stepUp';
  const fmt = (minor: string | undefined, currency: string | undefined) => (minor && (currency === 'USD' || currency === 'ILS') ? format(money(BigInt(minor), currency), intlLocale(locale)) : '');
  if (errorIs(e, { code: 'LIMIT_EXCEEDED' })) return { key: err.limitedBy === 'entitlement' ? 'pay.amount.overLimitPlan' : 'pay.amount.overLimit', vars: { remaining: fmt(err.remaining, err.currency) } };
  if (errorIs(e, { code: 'INSUFFICIENT_FUNDS' })) return { key: 'pay.amount.insufficient', vars: { available: fmt(err.available, err.currency) } };
  if (errorIs(e, { code: 'NOT_FOUND' })) return { key: 'pay.confirm.recipientGone' };
  if (errorIs(e, { code: 'FORBIDDEN' })) return { key: 'pay.confirm.unverified' };
  if (errorIs(e, { code: 'VALIDATION_FAILED' })) return { key: 'pay.recipient.invalid' };
  if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' }) || errorIs(e, { status: 409 })) return { key: 'pay.inbox.gone' };
  if (errorIs(e, { code: 'PROVIDER_UNAVAILABLE' })) return { key: 'pay.error.ratesUnavailable' };
  if (errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 503 })) return { key: 'common.error.unavailable' };
  return { key: 'common.error.generic' };
}

export const formatMoney = (m: Money | MoneyWire, locale: Locale): string => format('minor' in m && typeof m.minor === 'string' ? fromWire(m as MoneyWire) : (m as Money), intlLocale(locale));

// ---- the model --------------------------------------------------------------------------------

export interface PayModel {
  store: Store<PayState>;
  load(): Promise<void>;
  setCurrency(c: Currency): void;
  setRecipient(v: string): void;
  setAmount(v: string): void;
  setNote(v: string): void;
  /** M13: a contact from the phone book, resolved to a member by the API. */
  pickContact(): Promise<void>;
  /** M19 (scanner side): a code with the recipient and maybe an amount. */
  scan(): Promise<void>;
  /** M13 → M14 → M15: validates the step and moves on with the flow in the URL. */
  goAmount(): void;
  goConfirm(): void;
  /** M15: mints the confirm key once; a second call while the sheet is open keeps it. */
  openConfirm(): string;
  closeConfirm(): void;
  /** M15: asks the server what the recipient receives; a conversion shows the amount and the rate. */
  previewSend(): Promise<void>;
  send(): Promise<void>;
  cancelHold(): Promise<void>;
  /** M16. */
  request(): Promise<void>;
  /** M17. */
  setSplitTotal(v: string): void;
  addParticipant(id: string): void;
  removeParticipant(id: string): void;
  createSplit(): Promise<void>;
  /** M18. */
  payRequest(id: string): Promise<void>;
  declineRequest(id: string): Promise<void>;
  /** M19 (my code). */
  setQrAmount(v: string): void;
  qrPayload(): string;
  stepUpDone(): void;
}

export function createPayModel(deps: PayDeps, initial: Partial<Pick<PayState, 'recipient' | 'amountText' | 'note' | 'currency'>> = {}): PayModel {
  const locale = deps.locale ?? 'en';
  const store = createStore<PayState>({
    mode: 'loading',
    accounts: [],
    requests: [],
    currency: initial.currency ?? 'ILS',
    recipient: initial.recipient ?? '',
    amountText: initial.amountText ?? '',
    note: initial.note ?? '',
    busy: false,
    needsStepUp: false,
    previewing: false,
    split: { totalText: '', participants: [] },
    qrAmountText: '',
  });
  const fail = (e: unknown) => {
    const p = problemFor(e, locale);
    if (p === 'stepUp') return store.patch({ busy: false, needsStepUp: true });
    store.patch({ busy: false, error: p });
  };
  const clear = () => store.patch({ error: undefined, notice: undefined });
  const amountOrProblem = (): Money | undefined => {
    const s = store.get();
    const r = parseAmount(s.amountText, s.currency);
    if ('problem' in r) {
      store.patch({ error: { key: r.problem } });
      return undefined;
    }
    const avail = available(s.accounts, s.currency);
    if (s.mode === 'ready' && r.amount.minor > avail.minor) {
      store.patch({ error: { key: 'pay.amount.insufficient', vars: { available: format(avail, intlLocale(locale)) } } });
      return undefined;
    }
    return r.amount;
  };
  const recipientOk = (): boolean => {
    const v = store.get().recipient.trim();
    if (!isMemberId(v)) return void store.patch({ error: { key: 'pay.recipient.invalid' } }), false;
    if (v === deps.me) return void store.patch({ error: { key: 'pay.recipient.self' } }), false;
    return true;
  };
  const flowParams = () => {
    const s = store.get();
    return { to: s.recipient.trim(), amount: s.amountText, currency: s.currency, ...(s.note ? { note: s.note } : {}) };
  };
  // An explicit currency (the URL, a scanned code, the member's tap) is kept; otherwise M14 picks a purse with money.
  let pinned = initial.currency !== undefined;
  const refreshRequests = async () => {
    const { items } = await deps.pay.listRequests();
    store.patch({ requests: [...items] });
  };

  return {
    store,
    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const [accounts, requests] = await Promise.all([deps.pay.listAccounts(), deps.pay.listRequests()]);
        const s = store.get();
        const typed = parseAmount(s.amountText, s.currency);
        const currency = pinned ? s.currency : defaultPurse(accounts.items, s.currency, 'amount' in typed ? typed.amount.minor : 1n);
        store.patch({ mode: 'ready', accounts: [...accounts.items], requests: [...requests.items], currency });
      } catch (e) {
        store.patch({ mode: 'error', error: problemFor(e, locale) === 'stepUp' ? { key: 'common.error.generic' } : (problemFor(e, locale) as Problem) });
      }
    },
    setCurrency(c) {
      pinned = true;
      store.patch({ currency: c, error: undefined, preview: undefined });
    },
    setRecipient(v) {
      store.patch({ recipient: v, error: undefined });
    },
    setAmount(v) {
      store.patch({ amountText: v, error: undefined });
    },
    setNote(v) {
      store.patch({ note: v.slice(0, NOTE_MAX), error: undefined });
    },
    async pickContact() {
      clear();
      if (!deps.contacts) return store.patch({ error: { key: 'pay.recipient.contactsDenied' } });
      const r = await deps.contacts.pickOne();
      if (r.status === 'denied') return store.patch({ error: { key: 'pay.recipient.contactsDenied' } });
      if (r.status === 'cancelled') return;
      const id = deps.resolveContact ? await deps.resolveContact(r.contact.phone) : undefined;
      if (!id) return store.patch({ error: { key: 'pay.recipient.contactUnresolved' } });
      store.patch({ recipient: id });
    },
    async scan() {
      clear();
      if (!deps.camera) return store.patch({ error: { key: 'pay.recipient.cameraUnavailable' } });
      const r = await deps.camera.scanOnce();
      if (r.status === 'denied') return store.patch({ error: { key: 'pay.recipient.cameraDenied' } });
      if (r.status === 'unavailable') return store.patch({ error: { key: 'pay.recipient.cameraUnavailable' } });
      if (r.status === 'cancelled') return;
      const parsed = parseQr(r.payload);
      if (!parsed) return store.patch({ error: { key: 'pay.recipient.badCode' } });
      if (parsed.to === deps.me) return store.patch({ error: { key: 'pay.recipient.self' } });
      store.patch({ recipient: parsed.to, ...(parsed.amount ? { amountText: (Number(parsed.amount.minor) / 100).toFixed(2), currency: parsed.amount.currency } : {}) });
      deps.router.push(href('/pay/amount', flowParams()));
    },
    goAmount() {
      clear();
      if (recipientOk()) deps.router.push(href('/pay/amount', flowParams()));
    },
    goConfirm() {
      clear();
      if (recipientOk() && amountOrProblem()) deps.router.push(href('/pay/confirm', flowParams()));
    },
    openConfirm() {
      const s = store.get();
      if (s.confirmKey) return s.confirmKey;
      const key = deps.newKey();
      store.patch({ confirmKey: key, result: undefined, notice: undefined, error: undefined });
      return key;
    },
    closeConfirm() {
      store.patch({ confirmKey: undefined, needsStepUp: false, error: undefined, preview: undefined });
    },
    async previewSend() {
      const s = store.get();
      const parsed = parseAmount(s.amountText, s.currency);
      if (!isMemberId(s.recipient.trim()) || 'problem' in parsed) return;
      store.patch({ previewing: true });
      try {
        const preview = await deps.pay.preview({ toPartyId: s.recipient.trim(), amount: toWire(parsed.amount) });
        store.patch({ previewing: false, preview });
      } catch (e) {
        // The send would meet the same refusal: say it now rather than after the passkey.
        const p = problemFor(e, locale);
        store.patch({ previewing: false, preview: undefined, ...(p === 'stepUp' ? {} : { error: p }) });
      }
    },
    async send() {
      const s = store.get();
      if (!recipientOk()) return;
      const amount = amountOrProblem();
      if (!amount) return;
      const key = s.confirmKey ?? this.openConfirm();
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        const t = await deps.pay.send({ toPartyId: s.recipient.trim(), amount: toWire(amount), ...(s.note ? { note: s.note } : {}) }, key);
        const received = convertedTo(t);
        const notice: Problem = received ? { key: 'pay.confirm.sentConverted', vars: { amount: formatMoney(t.amount, locale), received: formatMoney(received, locale) } } : { key: 'pay.confirm.sent' };
        store.patch({ busy: false, result: t, needsStepUp: false, confirmKey: undefined, ...(t.state === 'pending_hold' ? {} : { notice }) });
        await this.load().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    },
    async cancelHold() {
      const t = store.get().result;
      if (!t || t.state !== 'pending_hold') return;
      store.patch({ busy: true, error: undefined });
      try {
        const c = await deps.pay.cancelTransfer(t.id, deps.newKey());
        store.patch({ busy: false, result: c, notice: { key: 'pay.hold.cancelled' } });
        await this.load().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    },
    async request() {
      const s = store.get();
      if (!recipientOk()) return;
      const r = parseAmount(s.amountText, s.currency);
      if ('problem' in r) return store.patch({ error: { key: r.problem } });
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        await deps.pay.createRequest({ payerPartyId: s.recipient.trim(), amount: toWire(r.amount), ...(s.note ? { note: s.note } : {}) }, deps.newKey());
        store.patch({ busy: false, notice: { key: 'pay.request.sent' }, amountText: '', note: '' });
        await refreshRequests().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    },
    setSplitTotal(v) {
      store.set((s) => ({ ...s, split: { ...s.split, totalText: v }, error: undefined }));
    },
    addParticipant(id) {
      const v = id.trim();
      if (!isMemberId(v)) return store.patch({ error: { key: 'pay.recipient.invalid' } });
      if (v === deps.me) return store.patch({ error: { key: 'pay.recipient.self' } });
      store.set((s) => ({ ...s, split: { ...s.split, participants: s.split.participants.includes(v) ? s.split.participants : [...s.split.participants, v] }, error: undefined }));
    },
    removeParticipant(id) {
      store.set((s) => ({ ...s, split: { ...s.split, participants: s.split.participants.filter((p) => p !== id) } }));
    },
    async createSplit() {
      const s = store.get();
      const r = parseAmount(s.split.totalText, s.currency);
      if ('problem' in r) return store.patch({ error: { key: r.problem } });
      if (s.split.participants.length === 0) return store.patch({ error: { key: 'pay.split.noOthers' } });
      if (!splitPreview(r.amount, s.split.participants.length)) return store.patch({ error: { key: 'pay.split.tooSmall' } });
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        const created = await deps.pay.createSplit({ total: toWire(r.amount), participants: s.split.participants, ...(s.note ? { note: s.note } : {}) }, deps.newKey());
        store.set((cur) => ({ ...cur, busy: false, split: { ...cur.split, created }, notice: { key: 'pay.split.created', vars: { n: created.requests.length } } }));
        await refreshRequests().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    },
    async payRequest(id) {
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        const paid = await deps.pay.payRequest(id, `pay-request-${id}`);
        store.patch({ busy: false, needsStepUp: false, result: paid.transfer, notice: paid.transfer.state === 'pending_hold' ? undefined : { key: 'pay.confirm.sent' } });
        await this.load().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    },
    async declineRequest(id) {
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        await deps.pay.declineRequest(id, `decline-request-${id}`);
        store.patch({ busy: false });
        await refreshRequests().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    },
    setQrAmount(v) {
      store.patch({ qrAmountText: v, error: undefined });
    },
    qrPayload() {
      const s = store.get();
      if (!s.qrAmountText.trim()) return buildQr(deps.me);
      const r = parseAmount(s.qrAmountText, s.currency);
      return buildQr(deps.me, 'amount' in r ? r.amount : undefined);
    },
    stepUpDone() {
      store.patch({ needsStepUp: false });
    },
  };
}

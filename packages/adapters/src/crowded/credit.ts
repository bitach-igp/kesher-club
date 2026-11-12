// The Crowded wallet credit (T-0741, REQ-WAL-003, ADR-018 A4/M1/M3): `FundingCreditPort.creditWallet` for a hosted load that settled.
// Flag: none of its own (an optional capability of the `funding` binding; the registry wiring and `CROWDED_FUND_HOLDING` are T-0709).
// FAKE-ONLY until Crowded answers README questions 29 and 35: fund holding is NOT enabled for our partner (`release-funds` answers 403
// "Held collection payments are not enabled"), the sandbox cannot drive a collection payment (question 37), and which account the money of
// a hosted collection lands in, and when, is unverified (question 35). Nothing here may be called live before those answers.
//
// Two modes, chosen by `fundHolding` (no default; a missing value crashes the constructor of `CrowdedFunding`):
// - `true`: `release-funds` for the amount (the held pool is pooled: "all held funds are consolidated"), then ONE book payment
//   `from_checking` to the member's wallet account.
// - `false`: no release call at all; the collected money is expected in the chapter's account already, so only the book payment is made.
//
// How the port's promises are kept on an API that gives less:
// - A refusal is final per key, a key is bound to its FIRST call (a replay answers the first answer, whatever the new input), and a
//   validation error is not cached (a bad call stores nothing). The record of a key (its load, account, amount, memo and how far it got)
//   lives in the `KeyLedger`; a `pending` answer resumes from it, never from the new input.
// - The wire keys are ours and derived (UUID v4, `bookWireKey`): `credit:release:` + key for the release, and for the book payment the
//   leg key is `bookWireKey('credit:', key)`, to which the mirror adds its own `mirror:` namespace, so a mirror leg and a credit of one
//   workflow id never share a wire key. (The release replay is an ASSUMPTION: Crowded may not replay a reused `release-funds` key, and
//   that cannot be probed while the 403 stands. So a release is only re-sent when the payment still reads `isReleased: false`.)
// - The book payment is made through the `MirrorPort` that is passed in (no second book client). Its memo is `load-credit:<load ref>:a<n>`,
//   at most 80 ASCII characters, unique per load AND attempt, no member text; `n` is the suffix of `{wf}:credit:{n}` when the key has one
//   and is unused for the load, else the next free number. An unknown outcome (`pending`, a lost answer) is resolved by `readBack` on that
//   memo before anything is resent, and the same leg key is the only one ever resent. A key of another attempt on a load whose earlier
//   attempt is still open never books: it reads the earlier one back and answers `pending` unless it settled.
// - The credit is per load: a load already credited answers `credited` for any key and moves nothing more. Calls on one key, and on one
//   load, run one at a time in this process (the ledger has no compare-and-swap beyond insert-if-absent).
// - The member's account is checked BEFORE any money moves (stored account refs skip the T-0740 gate after the first load): the account
//   must read `open` at the vendor, else the credit is refused ACCOUNT_UNAVAILABLE and nothing moves (a ref the vendor does not know is
//   refused NOT_FOUND). It is checked again on a resumed call that has not booked yet; once the book payment has been sent it is not.
//   If it froze after a release, the released money stays in the chapter's account.
// - Only a load that reads `succeeded` is credited. A load on hold (an ACH within its hold, and as `CrowdedFunding.getLoad` answers it
//   every time today) is refused NOT_SUCCEEDED: the port says money on hold is never credited. The caller owns the hold date (T-0705).
// - Errors: fixed text, never vendor text, a name, a mobile or an url.
import { money, type Money } from '@kesher/domain';
import { FundingError, MirrorError, type CreditResult, type LoadStatus, type MirrorLeg, type MirrorLegResult, type MirrorPort } from '@kesher/ports';
import { bookWireKey } from './book.ts';
import { CrowdedApiError, CrowdedTransportError, type CrowdedClient } from './client.ts';
import type { KeyLedger } from './institution-banking.ts';
import { isRecord, parseFundingRef, str, uuidFromKey } from './map.ts';

/** What `CrowdedFunding` knows of a load for the credit: the seam that keeps this file off the load ledger. */
export interface CreditLoadView {
  /** The load as its intent names it (both names of one load give the same one): the reference in the memo and in the ledger. */
  loadRef: string;
  status: LoadStatus;
  /** What the member intended. */
  amount: Money;
  /** The payment that stands for the load, when there is one (it has an id and a creation time once it Succeeded). */
  paymentId?: string;
  paymentAt?: Date;
}

export interface CreditDeps {
  client: CrowdedClient;
  chapterId: string;
  mirror: MirrorPort;
  fundHolding: boolean;
  /** Reads a load from the ledger and the vendor; `UNKNOWN_LOAD` (no request) for a load id we never made. */
  loadPayment: (loadId: string) => Promise<CreditLoadView>;
  ledger: KeyLedger;
  /** Serialises calls per key and per load within the process. */
  locks: Map<string, Promise<unknown>>;
}

/** Where a key got to. Plain JSON, so a ledger that persists can store it. */
interface Attempt {
  loadId: string;
  loadRef: string;
  accountRef: string;
  /** Cents, as a decimal string. */
  amount: string;
  memo: string;
  legKey: string;
  /** The release is done (it reported Sent, or the payment reads `isReleased`). */
  released?: boolean;
  /** The book payment has been, or may have been, sent. */
  booking?: boolean;
  final?: CreditResult;
}

interface LoadState {
  credited?: boolean;
  /** The key of the attempt that may still move money. */
  open?: string;
  memos: string[];
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MEMO_MAX = 80;
/** The window around a payment's creation in which its `GET /collect-payments` row is looked for, and the rows read at most. */
const WINDOW_MS = 60_000;
const MAX_ROWS = 2_000;
const REASONS = new Set(['INSUFFICIENT_FUNDS', 'ACCOUNT_UNAVAILABLE', 'NOT_FOUND']);

const fail = (code: 'VALIDATION_FAILED' | 'UNKNOWN_LOAD' | 'PROVIDER_UNAVAILABLE', message: string): never => {
  throw new FundingError(code, message);
};
const unavailable = (): never => fail('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
const refused = (reasonCode: string): CreditResult => ({ status: 'refused', reasonCode });
const pending: CreditResult = { status: 'pending' };

async function locked<T>(locks: Map<string, Promise<unknown>>, name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  const next = prev.then(() => fn());
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(name, tail);
  try {
    return await next;
  } finally {
    if (locks.get(name) === tail) locks.delete(name);
  }
}

export async function creditWallet(deps: CreditDeps, input: { loadId: string; accountRef: string; amount: Money }, key: string): Promise<CreditResult> {
  if (typeof key !== 'string' || !KEY.test(key)) return fail('VALIDATION_FAILED', 'The idempotency key must be 8 to 128 characters of letters, digits and ._:-');
  return locked(deps.locks, `credit:key:${key}`, () => withKey(deps, input, key));
}

async function withKey(deps: CreditDeps, input: { loadId: string; accountRef: string; amount: Money }, key: string): Promise<CreditResult> {
  const stored = (await deps.ledger.get(`credit:key:${key}`))?.result as Attempt | undefined;
  // A key is bound to its first call: its answer, if it has a final one, whatever this call asks.
  if (stored?.final) return stored.final;
  if (stored) return locked(deps.locks, `credit:load:${stored.loadRef}`, () => proceed(deps, key, stored, undefined));

  // A new key: validate before anything is stored or sent (a bad call is not cached).
  if (!isRecord(input) || typeof input.loadId !== 'string' || input.loadId === '') return fail('VALIDATION_FAILED', 'loadId is required');
  const a = input.amount;
  if (!isRecord(a) || a['currency'] !== 'USD' || typeof a['minor'] !== 'bigint' || a['minor'] <= 0n) return fail('VALIDATION_FAILED', 'The credit is a positive USD amount');
  if (a['minor'] > SAFE) return fail('VALIDATION_FAILED', 'The amount is too large for the provider');
  if (typeof input.accountRef !== 'string' || input.accountRef === '') return fail('VALIDATION_FAILED', 'accountRef is required');
  // A contact ref is not an account: it is refused here, with no request.
  if (input.accountRef.startsWith('c:')) return fail('VALIDATION_FAILED', 'The credit goes to a wallet account, not a contact');
  const minor = a['minor'];
  const view = await deps.loadPayment(input.loadId);
  if (view.amount.currency !== 'USD' || view.amount.minor !== minor) return fail('VALIDATION_FAILED', 'The amount is not the load amount');
  return locked(deps.locks, `credit:load:${view.loadRef}`, () => start(deps, key, { loadId: input.loadId, accountRef: input.accountRef, amount: minor }, view));
}

async function loadState(deps: CreditDeps, loadRef: string): Promise<LoadState> {
  const s = (await deps.ledger.get(`credit:load:${loadRef}`))?.result as LoadState | undefined;
  return s ?? { memos: [] };
}
const saveLoad = (deps: CreditDeps, loadRef: string, s: LoadState): Promise<void> => deps.ledger.put(`credit:load:${loadRef}`, { body: '', result: s });
const saveKey = (deps: CreditDeps, key: string, a: Attempt): Promise<void> => deps.ledger.put(`credit:key:${key}`, { body: '', result: a });

/** The memo: `load-credit:<intent id>:a<n>`; the intent id is `[A-Za-z0-9_-]`, so it is ASCII, and a long one is replaced by a hash. */
function memoFor(loadRef: string, n: number): string {
  const short = loadRef.split(':').at(-1) ?? loadRef;
  const m = `load-credit:${short}:a${n}`;
  return m.length <= MEMO_MAX ? m : `load-credit:${uuidFromKey(loadRef).replaceAll('-', '')}:a${n}`;
}

async function start(deps: CreditDeps, key: string, input: { loadId: string; accountRef: string; amount: bigint }, view: CreditLoadView): Promise<CreditResult> {
  const state = await loadState(deps, view.loadRef);
  const base = { loadId: input.loadId, loadRef: view.loadRef, accountRef: input.accountRef, amount: input.amount.toString(), memo: '', legKey: bookWireKey('credit:', key) };
  const close = async (result: CreditResult): Promise<CreditResult> => {
    await saveKey(deps, key, { ...base, final: result });
    return result;
  };
  if (state.credited) return close({ status: 'credited' });
  if (view.status !== 'succeeded') return close(refused('NOT_SUCCEEDED'));

  // Another attempt may still be moving money: never book beside it. Read it back; settled or refused ends the doubt, anything else waits.
  if (state.open !== undefined && state.open !== key) {
    const prior = (await deps.ledger.get(`credit:key:${state.open}`))?.result as Attempt | undefined;
    const r = prior ? await resolveAttempt(deps, prior) : undefined;
    if (r?.status === 'credited') {
      await saveLoad(deps, view.loadRef, { ...state, credited: true });
      return close({ status: 'credited' });
    }
    if (r?.status !== 'refused') return pending;
    delete state.open;
  }

  // The attempt number: the key's own `:credit:<n>` when the load has not used that memo, else the next free one.
  const suffix = /:credit:(\d{1,6})$/.exec(key);
  let n = suffix ? Number(suffix[1]) : state.memos.length + 1;
  while (state.memos.includes(memoFor(view.loadRef, n))) n++;
  const attempt: Attempt = { ...base, memo: memoFor(view.loadRef, n) };
  state.memos.push(attempt.memo);
  state.open = key;
  // The load's record and the key's record before any money call, so a call that dies finds its own work.
  await saveLoad(deps, view.loadRef, state);
  await saveKey(deps, key, attempt);
  return proceed(deps, key, attempt, view);
}

/** Reads an earlier attempt's payment back by its memo: what it became, or undefined when it cannot be told. */
async function resolveAttempt(deps: CreditDeps, a: Attempt): Promise<CreditResult | undefined> {
  if (a.final) return a.final;
  if (!a.booking) return undefined;
  try {
    const rb = await deps.mirror.readBack({ chapterRef: deps.chapterId, memo: a.memo, accountRef: a.accountRef, direction: 'from_checking', amount: money(BigInt(a.amount), 'USD') });
    return rb.status === 'found' ? fromLeg(rb.result, a) : undefined;
  } catch {
    return undefined;
  }
}

/** The book result as a credit result; a leg that is not the one we sent is never called credited. */
function fromLeg(r: MirrorLegResult, a: Attempt): CreditResult {
  if (r.status === 'refused') return refused(r.reasonCode && REASONS.has(r.reasonCode) ? r.reasonCode : 'PAYMENT_FAILED');
  if (r.status !== 'booked') return pending;
  const l = r.leg;
  if (l && (l.memo !== a.memo || l.accountRef !== a.accountRef || l.direction !== 'from_checking' || l.amount.currency !== 'USD' || l.amount.minor.toString() !== a.amount)) return pending;
  return { status: 'credited' };
}

async function finish(deps: CreditDeps, key: string, a: Attempt, result: CreditResult): Promise<CreditResult> {
  await saveKey(deps, key, { ...a, final: result });
  const state = await loadState(deps, a.loadRef);
  if (state.open === key) delete state.open;
  if (result.status === 'credited') state.credited = true;
  await saveLoad(deps, a.loadRef, state);
  return result;
}

async function proceed(deps: CreditDeps, key: string, a: Attempt, known: CreditLoadView | undefined): Promise<CreditResult> {
  const done = (r: CreditResult) => finish(deps, key, a, r);
  const state = await loadState(deps, a.loadRef);
  if (state.credited) return done({ status: 'credited' });

  if (!a.booking) {
    // Before any money moves: the member's account must be open at the vendor, now.
    const status = await accountStatus(deps, a.accountRef);
    if (status !== 'open') return done(refused(status));

    if (deps.fundHolding && !a.released) {
      const view = known ?? (await deps.loadPayment(a.loadId));
      const out = await release(deps, key, a, view);
      if (out !== 'released') return out.status === 'refused' ? done(out) : out;
      a.released = true;
      await saveKey(deps, key, a);
    }
    a.booking = true;
    await saveKey(deps, key, a);
  } else {
    // The book payment may have been sent: read it back by its memo before anything is resent.
    const found = await readBack(deps, a);
    if (found) return found.status === 'pending' ? found : done(found);
  }

  const leg: MirrorLeg = { direction: 'from_checking', accountRef: a.accountRef, amount: money(BigInt(a.amount), 'USD'), memo: a.memo, idempotencyKey: a.legKey };
  let result: MirrorLegResult | undefined;
  try {
    [result] = await deps.mirror.bookBatch([leg], deps.chapterId);
  } catch (e) {
    if (!(e instanceof MirrorError)) return unavailable();
    if (e.code === 'OUTCOME_UNKNOWN') return pending;
    if (e.code === 'NOT_FOUND') return done(refused('NOT_FOUND'));
    if (e.code === 'VALIDATION_FAILED') return done(refused('PAYMENT_FAILED'));
    return unavailable();
  }
  if (!result) return pending;
  if (result.status === 'unknown') {
    // The vendor may hold it (Pending, or an answer we could not read): `pending`, and the SAME key's next call reads it back by its memo.
    return pending;
  }
  const mapped = fromLeg(result, a);
  return mapped.status === 'pending' ? mapped : done(mapped);
}

async function readBack(deps: CreditDeps, a: Attempt): Promise<CreditResult | undefined> {
  try {
    const rb = await deps.mirror.readBack({ chapterRef: deps.chapterId, memo: a.memo, accountRef: a.accountRef, direction: 'from_checking', amount: money(BigInt(a.amount), 'USD') });
    if (rb.status === 'found') return fromLeg(rb.result, a);
    // Two payments under one memo: never guess which is ours.
    return rb.status === 'ambiguous' ? pending : undefined;
  } catch {
    return unavailable();
  }
}

/** `open`, or the reason the member's account cannot take the credit. Nothing has moved when this refuses. */
async function accountStatus(deps: CreditDeps, accountRef: string): Promise<'open' | 'ACCOUNT_UNAVAILABLE' | 'NOT_FOUND'> {
  if (parseFundingRef('a', accountRef) === undefined) return 'NOT_FOUND';
  try {
    const b = await deps.mirror.accountBalance(accountRef);
    return b.status === 'open' ? 'open' : 'ACCOUNT_UNAVAILABLE';
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return 'NOT_FOUND';
    return unavailable();
  }
}

/** The payment's own row in `GET /collect-payments`, narrowed by chapter and a window around its creation, matched by id. */
async function isReleased(deps: CreditDeps, paymentId: string, at: Date): Promise<boolean> {
  try {
    let rows = 0;
    for await (const row of deps.client.list('/collect-payments', { 'filter[chapterId]': deps.chapterId, 'filter[createdAt][min]': new Date(at.getTime() - WINDOW_MS).toISOString(), 'filter[createdAt][max]': new Date(at.getTime() + WINDOW_MS).toISOString() })) {
      if (++rows > MAX_ROWS) break;
      if (isRecord(row) && str(row['id']) === paymentId) return row['isReleased'] === true;
    }
  } catch {
    return unavailable();
  }
  // Not found: what the release did cannot be told, so nothing moves.
  return unavailable();
}

/**
 * Release the held funds for the amount, once. `released` when they are (the payment already reads `isReleased`, or the release reported
 * Sent); otherwise the credit's answer (pending, a refusal) or a throw (nothing was sent, or fund holding is off).
 */
async function release(deps: CreditDeps, key: string, a: Attempt, view: CreditLoadView): Promise<'released' | CreditResult> {
  if (!view.paymentId || !view.paymentAt) return unavailable();
  if (await isReleased(deps, view.paymentId, view.paymentAt)) return 'released';
  let data: unknown;
  try {
    data = (await deps.client.post(`/chapters/${deps.chapterId}/payments/release-funds`, { amount: Number(a.amount), idempotencyKey: bookWireKey('credit:release:', key) })).data;
  } catch (e) {
    if (e instanceof CrowdedApiError) {
      if (e.status === 403) return fail('PROVIDER_UNAVAILABLE', 'Fund holding is not enabled for the funding provider, so the held funds cannot be released');
      if (e.isAuth || e.status === 429) return unavailable();
      if (e.status === 400 || e.status === 422) return refused('PAYMENT_FAILED');
      return pending;
    }
    // A transport failure or anything unforeseen after the request may have left: the outcome is unknown.
    if (e instanceof CrowdedTransportError) return pending;
    return pending;
  }
  const status = isRecord(data) && typeof data['status'] === 'string' ? data['status'].toLowerCase() : '';
  if (status === 'sent') return 'released';
  if (status === 'rejected') {
    const code = isRecord(data) && typeof data['reasonCode'] === 'string' ? data['reasonCode'].toLowerCase() : '';
    return refused(code === 'insufficientfunds' ? 'INSUFFICIENT_FUNDS' : code === 'accountclosed' || code === 'accountfrozen' ? 'ACCOUNT_UNAVAILABLE' : 'PAYMENT_FAILED');
  }
  return pending;
}

// The load workflow (T-0764, split from loads.ts): the load constants and types, `runLoad` (the deterministic workflow body, pure over
// `LoadActivities` so Temporal, ADR-002, can host it unchanged) and `applyVendorState`. `loads.ts` re-exports every name here; its
// header comment tells the whole load story. Moved verbatim: no behaviour change.
import type { Currency, Money, toWire } from '@kesher/domain';
import { FundingError, type FundingMethod, type Load as VendorLoad } from '@kesher/ports';
import type { Transfer } from '../transfers/service.ts';

export const WALLET_FLAG = 'wallet.enabled';
/** Provider name the funding webhooks arrive under: POST /hooks/funding. */
export const FUNDING_PROVIDER = 'funding';
export const ACH_FLAG = 'funding.ach';
export const LOAD_METHODS: readonly FundingMethod[] = ['card', 'apple_pay', 'google_pay'];
export const PURSE_CURRENCIES: readonly Currency[] = ['USD', 'ILS'];
/** Journal kinds: the settlement (one per load, ever), the ACH hold into pending, and its release into the wallet. */
export const LOAD_JOURNAL_KIND = 'load';
export const HOLD_JOURNAL_KIND = 'load_hold';
export const RELEASE_JOURNAL_KIND = 'load_release';
/** An institution's ACH pull lands as a deposit (T-0617), the journal kind T-0614's recorded deposits post. */
export const INSTITUTION_DEPOSIT_JOURNAL_KIND = 'deposit';

export type LoadState = 'created' | 'requires_action' | 'processing' | 'on_hold' | 'settled' | 'failed';

export interface LoadInput {
  /** Who pays (their payment method, the vendor's customer). */
  payerPartyId: string;
  /** Whose purse is loaded: the payer, or a member the payer funds. */
  memberPartyId: string;
  method: FundingMethod;
  amount: Money;
  paymentMethodId?: string;
  /** The purse credited; the amount's currency when absent. */
  purse?: Currency;
  /** An institution's ACH pull (T-0617): payer and payee are the institution, and it lands in its own account. */
  kind?: 'deposit';
}

/** The OpenAPI `Load`. */
export interface LoadView {
  id: string;
  state: LoadState;
  amount: ReturnType<typeof toWire>;
  holdUntil?: string;
  clientSecret?: string;
  /** What the purse is credited, when the load converts. */
  credited?: ReturnType<typeof toWire>;
  /** The club rate version the load converted at. */
  rateVersion?: number;
}

export interface LoadActivities {
  /** The transfer for this workflow id, created on the first run and found on every later one. */
  begin(input: LoadInput, workflowId: string, now: Date): Promise<Transfer>;
  submit(transfer: Transfer, now: Date): Promise<Transfer>;
  /** The vendor pull, keyed by the workflow id: safe to repeat. */
  pull(input: LoadInput, workflowId: string): Promise<VendorLoad>;
  /** Remembers which vendor load belongs to the transfer so its webhooks find it. */
  link(transfer: Transfer, load: VendorLoad): Promise<void>;
  settle(transfer: Transfer, load: VendorLoad, workflowId: string, now: Date): Promise<Transfer>;
  /** The bank's hold: the money shows in the member's pending purse until `holdUntil` (REQ-WAL-003). */
  hold(transfer: Transfer, holdUntil: string, now: Date): Promise<Transfer>;
  /** On the hold date: pending → wallet, and the transfer settles. */
  release(transfer: Transfer, now: Date): Promise<Transfer>;
  /** A held load that fails (an ACH return) reverses its hold journal. */
  fail(transfer: Transfer, code: string, now: Date): Promise<Transfer>;
}

export interface LoadRun {
  workflowId: string;
  transfer: Transfer;
  /** Set while the vendor still needs the member (payment sheet) or time (processing). */
  awaiting?: 'action' | 'vendor';
  /** For the payment sheet; in the response only. */
  clientSecret?: string;
  /** True when the run found a transfer a previous run had already finished. */
  replayed: boolean;
}

/**
 * The workflow body. created → submitted → (vendor) → settled | failed | pending_hold, or left
 * submitted while the vendor is still working; a rerun resumes from wherever the record stands.
 */
export async function runLoad(a: LoadActivities, input: LoadInput, workflowId: string, now: Date): Promise<LoadRun> {
  let t = await a.begin(input, workflowId, now);
  if (t.state === 'settled' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'reversed' || t.state === 'pending_hold') return { workflowId, transfer: t, replayed: true };
  const replayed = t.state !== 'created';
  if (t.state === 'created') t = await a.submit(t, now);
  let load: VendorLoad;
  try {
    load = await a.pull(input, workflowId);
  } catch (e) {
    if (e instanceof FundingError && e.code === 'DECLINED') return { workflowId, transfer: await a.fail(t, e.code, now), replayed };
    // Anything else (outage, bad input) leaves the transfer submitted: the same key reruns the pull.
    throw e;
  }
  await a.link(t, load);
  return { ...(await applyVendorState(a, t, load, workflowId, now)), replayed };
}

/** Moves the transfer to where the vendor says the load stands. Idempotent: a state already reached is left alone. */
export async function applyVendorState(a: LoadActivities, t: Transfer, load: VendorLoad, workflowId: string, now: Date): Promise<Omit<LoadRun, 'replayed'>> {
  // A load in `pending` is a release that began and did not finish: whatever the vendor's calm answer, it finishes through the release
  // (which asks the vendor again and fails the load if it was returned). A `failed` answer takes the normal path below.
  if (t.state === 'pending' && (load.status === 'succeeded' || load.status === 'on_hold')) return { workflowId, transfer: await a.settle(t, load, workflowId, now) };
  switch (load.status) {
    case 'succeeded':
      // A held load stays held: the bank's hold days govern, and the release job settles it on the date.
      return { workflowId, transfer: t.state === 'settled' || t.state === 'pending_hold' ? t : await a.settle(t, load, workflowId, now) };
    case 'failed':
      return { workflowId, transfer: t.state === 'failed' ? t : await a.fail(t, load.failureCode ?? 'VENDOR_FAILED', now) };
    case 'on_hold':
      return { workflowId, transfer: t.state === 'pending_hold' || !load.holdUntil ? t : await a.hold(t, load.holdUntil, now) };
    case 'requires_action':
      return { workflowId, transfer: t, awaiting: 'action', ...(load.clientSecret ? { clientSecret: load.clientSecret } : {}) };
    case 'processing':
      return { workflowId, transfer: t, awaiting: 'vendor' };
  }
}

/**
 * How long the sweep leaves a held load alone after the vendor was last asked about it (T-0558). A load held for the bank's hold
 * days used to be read every cycle, hundreds of times for one load (vendor cost). Trade-off: a return no webhook announced is found
 * within this interval instead of within STALE_AFTER_MS (10 minutes); a webhook still fails the load at once, and a hold that is due
 * is asked every cycle until it releases, so the interval never delays a release.
 */
export const HELD_RECHECK_MS = 6 * 3_600_000;

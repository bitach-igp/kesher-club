// The pure helpers of a load (T-0764, split from loads.ts): the transfer's load state, the journal kind and metadata, what the purse is
// credited, the conversion's metadata and markup, the funding-error mapping and the webhook event id. No I/O, no class state.
// Moved verbatim apart from `export` on the names `LoadService` now imports: no behaviour change.
import { DomainError, money, toWire, type Money } from '@kesher/domain';
import { applyRate, FundingError } from '@kesher/ports';
import { rateString } from '../fx/service.ts';
import type { Transfer, TransferConversion } from '../transfers/service.ts';
import { INSTITUTION_DEPOSIT_JOURNAL_KIND, type LoadState } from './load-workflow.ts';

export function loadState(t: Transfer, awaiting?: 'action' | 'vendor'): LoadState {
  switch (t.state) {
    case 'created':
      return 'created';
    case 'submitted':
      return awaiting === 'action' ? 'requires_action' : 'processing';
    case 'pending':
    case 'pending_hold':
      return 'on_hold';
    case 'settled':
    case 'reversed':
      return 'settled';
    case 'failed':
    case 'cancelled':
      return 'failed';
  }
}

/** A member's load books its own journal kinds; an institution's pull lands as a deposit (T-0617). */
export const journalKind = (t: Transfer, memberKind: string): string => (t.kind === 'deposit' ? INSTITUTION_DEPOSIT_JOURNAL_KIND : memberKind);

/** The institution and the rail on an institution's pull, as the monthly export reads a deposit. */
export const institutionMetadata = (t: Transfer): Record<string, unknown> => (t.kind === 'deposit' ? { institutionId: t.toPartyId, rail: 'ach', description: 'ACH pull from the institution\'s bank' } : {});

/** What the member's purse receives: the conversion's amount, or the load itself. */
export function credited(t: Transfer): Money {
  return t.conversion?.received ?? t.amount;
}

export function conversionMetadata(t: Transfer): Record<string, unknown> {
  const c = t.conversion;
  if (!c) return {};
  return {
    fx_rate_version: c.rateVersion,
    fx_rate_id: c.rateId,
    fx_markup_bps: Number(c.markupBps),
    rateScaled: c.rateScaled.toString(),
    rate: rateString(c.rateScaled),
    loaded: toWire(t.amount),
    credited: toWire(c.received),
    markup: toWire(money(markupOf(t, c), c.received.currency)),
  };
}

/** The markup kept by fee income: the gross at the rate applied, less what the purse was credited. */
export function markupOf(t: Transfer, c: TransferConversion): bigint {
  return applyRate(t.amount.minor, c.rateScaled) - c.received.minor;
}

export function mapFundingError(e: unknown): Error {
  if (e instanceof FundingError) {
    if (e.code === 'PROVIDER_UNAVAILABLE') return new DomainError('PROVIDER_UNAVAILABLE', 'Funding is temporarily unavailable; try again with the same key');
    if (e.code === 'UNSUPPORTED_METHOD') return new DomainError('VALIDATION_FAILED', 'This funding method is not supported');
    if (e.code === 'VALIDATION_FAILED') return new DomainError('VALIDATION_FAILED', e.message);
  }
  return e as Error;
}

/** The vendor's event id from the raw body, for the forensic record of a refused webhook. */
export function eventIdOf(rawBody: string): { eventId: string; body: unknown } {
  try {
    const b = JSON.parse(rawBody) as { eventId?: unknown; id?: unknown } | null;
    return { eventId: typeof b?.eventId === 'string' ? b.eventId : typeof b?.id === 'string' ? b.id : '', body: b ?? {} };
  } catch {
    return { eventId: '', body: { raw: rawBody.slice(0, 2_000) } };
  }
}

// Pricing, journal legs and request parsing of a load (T-0501, T-0517, ADR-007), split from loads.ts (T-0767): the one conversion a load into
// another purse is priced at when it begins, the postings of its settle and hold journals, where a load lands, and the POST /loads body
// checks. Moved from LoadService with the SQL, the ordering, the account lookups and the error text unchanged; each function takes the
// narrow slice of `Deps` it reads and returns a plain value.
import { applyBps, DomainError, fromWire, money, sub, type Currency, type Money, type Posting } from '@kesher/domain';
import { applyRate, type FundingAccountPort, type FundingMethod } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { MembershipService } from '../billing/memberships.ts';
import type { RateService } from '../fx/rates.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { Transfer, TransferConversion } from '../transfers/service.ts';
import type { FundingDetails } from './load-accounts.ts';
import { markupOf } from './load-model.ts';
import { ACH_FLAG, LOAD_METHODS, PURSE_CURRENCIES, type LoadInput } from './load-workflow.ts';

/** The part of `LoadService`'s dependencies the pricing step reads. */
export interface PricingDeps {
  rates?: Pick<RateService, 'rateFor'> | undefined;
  markups?: { markupFor(partyId: string): Promise<bigint> } | undefined;
}

/** The part of `LoadService`'s dependencies the journal legs read. */
export interface LegsDeps {
  accounts: AccountService;
}

/** The part of `LoadService`'s dependencies the request parsing reads. */
export interface ParseDeps {
  flags: FeatureFlags;
  memberships: MembershipService;
  fundingAccounts?: FundingAccountPort | undefined;
  details?: { read(partyId: string): Promise<FundingDetails | undefined> } | undefined;
}

/**
 * The conversion a load into another purse settles at: the club rate, less the purse owner's plan markup,
 * like every conversion (ADR-007, ADR-014 decision 2). At the mid rate a load through the other purse would
 * be a free conversion that undercuts the convert screen.
 */
export async function price(d: PricingDeps, input: LoadInput, now: Date): Promise<TransferConversion | undefined> {
  const purse = input.purse ?? input.amount.currency;
  if (purse === input.amount.currency) return undefined;
  if (!d.rates || !d.markups) throw new DomainError('PROVIDER_UNAVAILABLE', 'Loads into another currency are not available right now');
  const rate = await d.rates.rateFor(input.amount.currency, purse, now);
  const markupBps = await d.markups.markupFor(input.memberPartyId);
  const gross = money(applyRate(input.amount.minor, rate.rateScaled), purse);
  const received = sub(gross, applyBps(gross, markupBps));
  if (received.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'The amount is too small to convert');
  return { received, rateId: rate.rateId, rateVersion: rate.version, rateScaled: rate.rateScaled, markupBps };
}

/**
 * partner_settlement in the instrument currency to the member's wallet or pending purse. Same currency:
 * two legs. Converting: fx_position takes the instrument amount and pays out the gross in the purse
 * currency; the purse takes the credited amount and fee income the markup, when above zero. Balanced per
 * currency; the gap to the vendor's real rate is fx_position's to carry.
 */
export async function legs(d: LegsDeps, transfer: Transfer, into: 'wallet' | 'pending'): Promise<Posting[]> {
  const { minor, currency } = transfer.amount;
  const partner = await d.accounts.systemAccount('partner_settlement', currency);
  const c = transfer.conversion;
  if (!c) {
    const dest = await destination(d, transfer, into, currency);
    return [
      { accountId: partner, currency, amountMinor: minor },
      { accountId: dest, currency, amountMinor: -minor },
    ];
  }
  const to = c.received.currency;
  const dest = await destination(d, transfer, into, to);
  const markup = markupOf(transfer, c);
  return [
    { accountId: partner, currency, amountMinor: minor },
    { accountId: await d.accounts.systemAccount('fx_position', currency), currency, amountMinor: -minor },
    { accountId: await d.accounts.systemAccount('fx_position', to), currency: to, amountMinor: c.received.minor + markup },
    { accountId: dest, currency: to, amountMinor: -c.received.minor },
    ...(markup > 0n ? [{ accountId: await d.accounts.systemAccount('fee_income', to), currency: to, amountMinor: -markup }] : []),
  ];
}

/** Where a load lands: the member's wallet or pending purse, or for an institution's pull its own account or its hold. */
export function destination(d: LegsDeps, transfer: Transfer, into: 'wallet' | 'pending', currency: Currency): Promise<string> {
  const owner = transfer.toPartyId!;
  if (transfer.kind !== 'deposit') return d.accounts.memberAccount(owner, into, currency);
  return into === 'wallet' ? d.accounts.institutionAccount(owner, currency) : d.accounts.institutionHoldAccount(owner, currency);
}

export async function parse(d: ParseDeps, payerPartyId: string, body: unknown): Promise<LoadInput> {
  const b = (body ?? {}) as { memberPartyId?: unknown; amount?: unknown; method?: unknown; paymentMethodId?: unknown; purseCurrency?: unknown };
  if (typeof b.memberPartyId !== 'string' || !b.memberPartyId) throw new DomainError('VALIDATION_FAILED', 'memberPartyId is required');
  if (b.method === 'ach' && !(await d.flags.isOn(ACH_FLAG))) throw new DomainError('FEATURE_OFF', 'Bank loads are not enabled yet');
  // `hosted` is accepted only here, behind the account gate; its request fields and consent are T-0714.
  if (b.method === 'hosted') {
    if (b.memberPartyId !== payerPartyId) throw new DomainError('FORBIDDEN', 'You can load your own purse with a hosted payment');
    if (!d.fundingAccounts || !d.details) throw new DomainError('FEATURE_OFF', 'Hosted loads are not enabled yet');
  } else if (b.method === 'rtp') throw new DomainError('FEATURE_OFF', 'Instant bank loads are not enabled yet');
  if (typeof b.method !== 'string' || (b.method !== 'ach' && b.method !== 'hosted' && !LOAD_METHODS.includes(b.method as FundingMethod))) throw new DomainError('VALIDATION_FAILED', `method must be one of ${[...LOAD_METHODS, 'ach'].join(', ')}`);
  let amount: Money;
  try {
    amount = fromWire(b.amount as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency } in USD or ILS');
  }
  if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
  if (b.paymentMethodId !== undefined && typeof b.paymentMethodId !== 'string') throw new DomainError('VALIDATION_FAILED', 'paymentMethodId must be a string');
  if (b.purseCurrency !== undefined && !PURSE_CURRENCIES.includes(b.purseCurrency as Currency)) throw new DomainError('VALIDATION_FAILED', `purseCurrency must be one of ${PURSE_CURRENCIES.join(', ')}`);
  if (b.memberPartyId !== payerPartyId) {
    const m = await d.memberships.forMember(b.memberPartyId);
    if (!m || m.funderPartyId !== payerPartyId || m.status !== 'active') throw new DomainError('FORBIDDEN', 'You can load your own purse or one you fund');
  }
  return {
    payerPartyId,
    memberPartyId: b.memberPartyId,
    method: b.method as FundingMethod,
    amount,
    ...(typeof b.paymentMethodId === 'string' ? { paymentMethodId: b.paymentMethodId } : {}),
    ...(b.purseCurrency !== undefined ? { purse: b.purseCurrency as Currency } : {}),
  };
}

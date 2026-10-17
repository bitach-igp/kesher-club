// Customer 360 view (T-0901, A01): one page that answers "what is going on with this person" with
// nothing an ops admin should not see. Phone and email are masked; there is no PAN anywhere.
import { format, type Money } from '@kesher/domain';
import type { CustomerRecord } from '../data/types.ts';

export interface Customer360 {
  partyId: string;
  displayName: string;
  phoneMasked: string;
  emailMasked: string | undefined;
  locale: 'en' | 'he';
  mode: CustomerRecord['mode'];
  memberSince: string;
  flags: string[];
  kyc: CustomerRecord['kyc'];
  memberships: CustomerRecord['memberships'];
  balances: { id: string; currency: 'USD' | 'ILS'; available: string; holds: string; spendable: string }[];
  cards: CustomerRecord['cards'];
  openCases: CustomerRecord['cases'];
  consents: CustomerRecord['consents'];
  activeGrants: CustomerRecord['grants'];
  audit: CustomerRecord['audit'];
}

/**
 * +972501234567 → •••• 4567. Only the last four digits survive; country codes narrow a person down
 * too. A phone the API already masked (T-0907) passes through unchanged.
 */
export function maskPhone(e164: string): string {
  if (/^•••• \d{4}$/.test(e164)) return e164;
  const m = /^\+\d{3,}(\d{4})$/.exec(e164);
  return m ? `•••• ${m[1]}` : '••••';
}

/** noa@example.com → n••@example.com */
export function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split('@');
  if (!local || !domain) return '•••';
  return `${local[0]}••@${domain}`;
}

const fmt = (m: Money) => format(m, 'en-US');

export function customer360(c: CustomerRecord, now: Date): Customer360 {
  const flags: string[] = [];
  if (c.restrictedUntil && Date.parse(c.restrictedUntil) > now.getTime()) flags.push('recovery_hold');
  if (c.kyc.status !== 'verified') flags.push(`kyc_${c.kyc.status}`);
  if (c.cards.some((k) => k.status === 'frozen')) flags.push('card_frozen');
  if (c.cases.some((k) => k.status === 'open' || k.status === 'investigating')) flags.push('open_case');
  if (c.memberships.some((m) => m.status === 'past_due')) flags.push('past_due');
  return {
    partyId: c.partyId,
    displayName: c.displayName,
    phoneMasked: maskPhone(c.phone),
    emailMasked: maskEmail(c.email),
    locale: c.locale,
    mode: c.mode,
    memberSince: c.createdAt.slice(0, 10),
    flags,
    kyc: c.kyc,
    memberships: c.memberships,
    balances: c.accounts.map((a) => ({ id: a.id, currency: a.currency, available: fmt(a.available), holds: fmt(a.holds), spendable: fmt({ minor: a.available.minor - a.holds.minor, currency: a.currency }) })),
    cards: c.cards,
    openCases: c.cases.filter((k) => k.status === 'open' || k.status === 'investigating'),
    consents: c.consents,
    activeGrants: c.grants.filter((g) => !g.revokedAt),
    audit: [...c.audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
  };
}

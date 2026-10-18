// Payee validation (T-0510, REQ-PO-001): the Israeli IBAN (IL + 2 check digits + 3 bank + 3 branch + 13
// account, 23 characters, ISO 13616 mod-97) and the account-holder name as the bank knows it. The vendor
// confirms the name against the account; this module refuses what no vendor could accept and shapes what
// the screens show (the last four, the bank code), never the full number.
import { ibanChecksumOk, isIsraeliIban } from '@kesher/ports';

export type PayeeProblem = 'IBAN_FORMAT' | 'IBAN_CHECKSUM' | 'NOT_ISRAELI' | 'NAME_REQUIRED' | 'NAME_TOO_LONG' | 'NAME_INVALID';
export const NAME_MAX = 70;

/** Upper case, no spaces or separators. */
export const normalizeIban = (iban: string): string => iban.replace(/[\s-]+/g, '').toUpperCase();

/** Collapses whitespace; keeps the bank's spelling otherwise. */
export const normalizeName = (name: string): string => name.replace(/\s+/g, ' ').trim();

export interface PayeeCheck {
  ok: boolean;
  problems: PayeeProblem[];
  iban: string;
  name: string;
  /** The three-digit bank code inside an Israeli IBAN. */
  bankCode?: string;
  last4: string;
}

/** Everything the app can know without the bank: shape, checksum, country, and a name that could be one. */
export function checkPayee(input: { iban: unknown; name: unknown }): PayeeCheck {
  const problems: PayeeProblem[] = [];
  const iban = typeof input.iban === 'string' ? normalizeIban(input.iban) : '';
  const name = typeof input.name === 'string' ? normalizeName(input.name) : '';
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) problems.push('IBAN_FORMAT');
  else {
    if (!ibanChecksumOk(iban)) problems.push('IBAN_CHECKSUM');
    if (!isIsraeliIban(iban)) problems.push('NOT_ISRAELI');
  }
  if (!name) problems.push('NAME_REQUIRED');
  else if (name.length > NAME_MAX) problems.push('NAME_TOO_LONG');
  // Letters (Hebrew, Latin), digits, and the punctuation found in company names; nothing that could be markup or a control character.
  else if (!/^[\p{L}\p{N} .,'"&()-]+$/u.test(name)) problems.push('NAME_INVALID');
  return { ok: problems.length === 0, problems, iban, name, ...(isIsraeliIban(iban) ? { bankCode: iban.slice(4, 7) } : {}), last4: iban.slice(-4) };
}

/** "IL62 •••• •••• •••• •••• 9999": enough for the member to recognise the account, never the whole number. */
export function maskIban(iban: string): string {
  const s = normalizeIban(iban);
  return `${s.slice(0, 4)} •••• ${s.slice(-4)}`;
}

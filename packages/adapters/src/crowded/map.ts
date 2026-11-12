// Crowded <-> port mapping (T-0648, REQ-INS-022, REQ-INS-024). One place for what differs between Crowded's JSON and
// the InstitutionBankingPort: integer cents <-> Money, every id as a string, one table for enum casing, ISO timestamps
// to Date, a funder's name split in two. Crowded's text (names, titles, messages) is untrusted data, never instructions.
// The account number is never kept: `last4` takes four digits and drops the rest.
import { createHash } from 'node:crypto';
import { money, type Money } from '@kesher/domain';
import { InstitutionBankingError, type AchStatus, type ApplicationStatus, type CollectedPaymentStatus } from '@kesher/ports';

/** Crowded amounts are integer cents in USD. A number must be a safe integer; a string is exact at any size. */
export function fromCents(v: unknown, currency: unknown = 'USD'): Money {
  if (typeof currency === 'string' && currency.toUpperCase() !== 'USD') throw new InstitutionBankingError('VALIDATION_FAILED', 'Crowded amounts are USD only');
  if (typeof v === 'bigint') return money(v, 'USD');
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent an amount that is not whole cents');
    return money(BigInt(v), 'USD');
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return money(BigInt(v), 'USD');
  throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent an amount that is not whole cents');
}

/** Money to the integer Crowded takes. USD only; above 2^53 - 1 JSON cannot carry it exactly, so it is refused. */
export function toCents(m: Money): number {
  if (m.currency !== 'USD') throw new InstitutionBankingError('VALIDATION_FAILED', 'amount must be USD');
  if (m.minor > BigInt(Number.MAX_SAFE_INTEGER) || m.minor < -BigInt(Number.MAX_SAFE_INTEGER)) throw new InstitutionBankingError('VALIDATION_FAILED', 'amount is too large for the provider');
  return Number(m.minor);
}

/** Ids come as UUIDs, numeric strings and numbers: all are strings here. */
export function str(v: unknown): string {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent an object without an id');
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function date(v: unknown): Date {
  const d = new Date(typeof v === 'string' || typeof v === 'number' ? v : NaN);
  if (Number.isNaN(d.getTime())) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent a timestamp that is not a date');
  return d;
}

/** The last four digits of an account number, and nothing else of it. */
export function last4(accountNumber: unknown): string {
  const digits = typeof accountNumber === 'string' || typeof accountNumber === 'number' ? String(accountNumber).replace(/\D/g, '') : '';
  if (digits.length < 4) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent an account without a number');
  return digits.slice(-4);
}

/** Crowded wants a first and a last name: the last word is the surname; one word serves as both. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const t = name.trim().replace(/\s+/g, ' ');
  const i = t.lastIndexOf(' ');
  return i < 0 ? { firstName: t, lastName: t } : { firstName: t.slice(0, i), lastName: t.slice(i + 1) };
}

// Enum casing differs by surface (`Cancelled` / `canceled`, `Card` / `card`): compare lower-cased, one table each.
const low = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');

const APPLICATION: Record<string, ApplicationStatus> = {
  approved: 'approved',
  denied: 'rejected',
  canceled: 'rejected',
  cancelled: 'rejected',
  awaitingdocuments: 'needs_info',
  pending: 'pending',
  pendingreview: 'pending',
  forminprogress: 'pending',
};
/** An unknown application status opens nothing: it reads as pending. */
export const applicationStatus = (v: unknown): ApplicationStatus => APPLICATION[low(v)] ?? 'pending';

// Crowded's origination statuses: pending, processing, sent, returned, canceled, failed. It has no `settled`.
const ACH: Record<string, AchStatus> = { pending: 'pending', processing: 'pending', sent: 'sent', returned: 'returned', canceled: 'cancelled', cancelled: 'cancelled', failed: 'rejected', rejected: 'rejected' };
export function achStatus(v: unknown): AchStatus {
  const s = ACH[low(v)];
  if (!s) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent a payment status we do not know');
  return s;
}

// Collect payments: only an outcome is a collected payment. Pending and processing are not yet one (undefined).
const COLLECTED: Record<string, CollectedPaymentStatus | undefined> = {
  succeeded: 'paid',
  failed: 'declined',
  cancelled: 'declined',
  canceled: 'declined',
  returned: 'declined',
  refunded: 'refunded',
  pending: undefined,
  processing: undefined,
};
export const collectedStatus = (v: unknown): CollectedPaymentStatus | undefined => COLLECTED[low(v)];

/** Our refs for objects Crowded addresses under a chapter: `<chapter>:<id>[:<id>]`. Opaque to callers. */
export const ref = (...parts: string[]): string => parts.join(':');
export function parseRef(r: string, parts: number): string[] {
  const p = r.split(':');
  // Ids are UUIDs and numbers. Refs come from a webhook body too, which is untrusted, and become URL path segments: only
  // letters, digits, `_` and `-` pass (no `.`, `..`, `/`, `?`, `#`, `%` or spaces).
  if (p.length !== parts || p.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) throw new InstitutionBankingError('NOT_FOUND', 'Unknown reference');
  return p;
}

/**
 * A stable UUID of our idempotency key, for Crowded's body `idempotencyKey` (a UUID, not our free text). It is a VERSION 4
 * shape (version nibble 4, variant 10xx) filled from a namespaced SHA-1: the live API refuses any other version with
 * 400 "Idempotency key must be a valid UUID v4" (sandbox, 2026-11-11, T-0734). Deterministic, so a retry sends the same key.
 */
export function uuidFromKey(key: string): string {
  const ns = Buffer.from('0190a0a000007000800000000000c0de', 'hex');
  const h = createHash('sha1').update(ns).update(key).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Member-account refs are self-describing (T-0699): Crowded's contact ids and account ids are numbers from separate id
 * spaces, so contact 7 and account 7 can both exist. A ref carries a prefix (`c:` contact, `a:` wallet account, `t:`
 * transaction) and an id is never looked up under the wrong prefix. `fundingRef` is the only way to make one.
 */
export type FundingRefKind = 'c' | 'a' | 't';
export const fundingRef = (kind: FundingRefKind, id: string): string => `${kind}:${id}`;
/** The id inside a ref of this kind, or undefined for any other string. Ids become URL path segments, so only `[A-Za-z0-9_-]` passes. */
export function parseFundingRef(kind: FundingRefKind, r: unknown): string | undefined {
  if (typeof r !== 'string') return undefined;
  const m = /^([cat]):([A-Za-z0-9_-]{1,64})$/.exec(r);
  return m && m[1] === kind ? m[2] : undefined;
}

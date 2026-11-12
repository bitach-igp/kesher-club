// FundingPort (REQ-WAL-002/003/005): loads into a member's wallet by card, Apple Pay, Google Pay, ACH
// or RTP, and refunds back to a load's source when a purse is emptied on closure. The port creates the
// pull or the refund at the vendor; the ledger journal is posted by the workflow after the vendor
// confirms (SEQ-02). ACH loads carry the bank's hold days.
import type { Money } from '@kesher/domain';

/** `hosted`: the payer picks card or bank on the vendor's payment page; a `Load` read after payment carries the method actually used. */
export type FundingMethod = 'card' | 'apple_pay' | 'google_pay' | 'ach' | 'rtp' | 'hosted';
export type LoadStatus = 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'on_hold';

/** A payment page to open (an `embed` kind may follow). */
export interface LoadAction {
  type: 'payment_page';
  url: string;
  /** ISO 8601 UTC. */
  expiresAt?: string;
}

/**
 * The payer's details a hosted load needs: the vendor's intent requires the payer's public IP and explicit consent (ADR-018 A3).
 * `payerIp` must satisfy `isPublicIp`; `successUrl` and `failureUrl` must satisfy `isHttpsUrl`. Restricting redirects to an
 * allowlist of our own hosts is the adapter's job (T-0700), not the port's.
 */
export interface HostedLoadInput {
  payerIp: string;
  userConsented: true;
  successUrl?: string;
  failureUrl?: string;
}

export interface Load {
  loadId: string;
  method: FundingMethod;
  amount: Money;
  status: LoadStatus;
  /** ACH: funds spendable from this date ("On hold until {date}", REQ-WAL-003). */
  holdUntil?: string;
  /** Client-side secret for a payment sheet when status is requires_action. Never logged. */
  clientSecret?: string;
  /** What the payer must do next while status is requires_action and the vendor hosts the payment. The url is never logged. */
  action?: LoadAction;
  failureCode?: string;
  /** What the vendor or the creator attached to the load, as text. Absent when there is none. Never carries personal data (T-0735). */
  metadata?: Readonly<Record<string, string>>;
}

/** An IPv4 literal as four octets, or undefined (no leading zeros, each 0-255). */
function v4Octets(ip: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const o = m.slice(1).map((x) => (x.length > 1 && x.startsWith('0') ? NaN : Number(x)));
  return o.every((n) => n >= 0 && n <= 255) ? o : undefined;
}

function publicV4(o: readonly number[]): boolean {
  const [a, b] = o as [number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  return !(a === 192 && b === 168);
}

/** Eight 16-bit groups of an IPv6 literal (with `::` and an embedded IPv4 tail), or undefined. No zone ids. */
function v6Groups(ip: string): number[] | undefined {
  if (!/^[0-9a-f:.]+$/i.test(ip) || (ip.match(/::/g) ?? []).length > 1) return undefined;
  let tail: number[] = [];
  let text = ip;
  const dot = ip.lastIndexOf(':') >= 0 ? ip.slice(ip.lastIndexOf(':') + 1) : '';
  if (dot.includes('.')) {
    const o = v4Octets(dot);
    if (!o) return undefined;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    text = ip.slice(0, ip.lastIndexOf(':') + 1) + '0:0';
  }
  const [head, rest, extra] = text.split('::');
  if (extra !== undefined) return undefined;
  const parse = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part === '') return [];
    const gs = part.split(':');
    return gs.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? gs.map((g) => parseInt(g, 16)) : undefined;
  };
  const h = parse(head);
  const r = text.includes('::') ? parse(rest) : [];
  if (!h || !r) return undefined;
  const fill = 8 - h.length - r.length;
  if (text.includes('::') ? fill < 1 : fill !== 0) return undefined;
  const groups = [...h, ...new Array<number>(text.includes('::') ? fill : 0).fill(0), ...r];
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 ? groups : undefined;
}

/**
 * True for an IPv4 or IPv6 literal on the public internet: not private, loopback, link-local, unspecified, CGNAT, multicast or
 * reserved, and an IPv4-mapped form (`::ffff:a.b.c.d`) is judged by the IPv4 address inside it. A hosted load's `payerIp` must pass.
 */
export function isPublicIp(ip: string): boolean {
  const o = v4Octets(ip);
  if (o) return publicV4(o);
  const g = v6Groups(ip);
  if (!g) return false;
  const g0 = g[0]!;
  const low = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return publicV4(low); // mapped, compatible, ::, ::1
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2002) return false; // 6to4: embeds an IPv4 that may be private, and we do not decode it
  if (g0 === 0x2001 && g[1] === 0x0db8) return false; // documentation (2001:db8::/32)
  return (g0 & 0xe000) === 0x2000; // only global unicast is public
}

/** True for an absolute URL with protocol exactly `https:`, a host and no credentials. */
export function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === '' && /^https:\/\/[^/?#\\]/.test(url);
  } catch {
    return false;
  }
}

/** Throws VALIDATION_FAILED unless `isHttpsUrl(url)`. Adapters reuse it for every url they hand out or pass to the vendor. */
export function assertHttps(url: string, what = 'url'): void {
  if (!isHttpsUrl(url)) throw new FundingError('VALIDATION_FAILED', `${what} must be an https url without credentials`);
}

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

/** Money returned to the source of a load (REQ-WAL-005). Partial refunds are allowed up to the load's amount. */
export interface Refund {
  refundId: string;
  loadId: string;
  amount: Money;
  status: RefundStatus;
  failureCode?: string;
}

export interface FundingPort {
  createLoad(input: { customerId: string; method: FundingMethod; amount: Money; paymentMethodId?: string; hosted?: HostedLoadInput; metadata?: Readonly<Record<string, string>> }, idempotencyKey: string): Promise<Load>;
  getLoad(loadId: string): Promise<Load>;
  /** Returns up to the load's remaining amount to its source. Same key → the same refund. */
  refund(input: { loadId: string; amount: Money }, idempotencyKey: string): Promise<Refund>;
  getRefund(refundId: string): Promise<Refund>;
  /** Verifies and maps a vendor webhook (payment_intent.succeeded etc.). Duplicate ids return the same event. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; load: Load }>;
}

export type SettledKind = 'charge' | 'refund';

/**
 * One settled money movement at the funding vendor (T-0683): a load that succeeded (`charge`, `id` is the loadId) or a
 * refund that succeeded (`refund`, `id` is the refundId). `amount` is positive; the kind carries the direction.
 */
export interface SettledEntry {
  kind: SettledKind;
  id: string;
  loadId: string;
  amount: Money;
  /** The instant it settled at the vendor, ISO 8601 UTC. */
  settledAt: string;
}

export interface SettledPage {
  entries: SettledEntry[];
  /** Pass back as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
}

/**
 * The statement side of the funding vendor, for reconciliation (REQ-LED-004). Kept apart from FundingPort so a
 * workflow that only moves money does not have to implement it; the simulator and the Stripe adapter do.
 */
export interface FundingStatementPort {
  /** Settled charges and refunds with `from <= settledAt < to` (ISO instants), in no guaranteed order, `limit` per page (default 100). */
  listSettled(input: { from: string; to: string; cursor?: string; limit?: number }): Promise<SettledPage>;
}

/** The result of moving a settled load's money into the member's wallet account at the vendor (T-0704). */
export type CreditStatus = 'credited' | 'pending' | 'refused';

export interface CreditResult {
  status: CreditStatus;
  /**
   * Set when `refused`: a short closed string chosen by the port, never vendor text. `NOT_SUCCEEDED`, `NOT_FOUND`,
   * `INSUFFICIENT_FUNDS`, `ACCOUNT_UNAVAILABLE` or `PAYMENT_FAILED`; a `string` so an adapter can add one. The caller only logs and cases it.
   */
  reasonCode?: string;
}

/**
 * The credit step of a hosted load (REQ-WAL-003, ADR-018 A4/M1/M3): after the load settled at the vendor, move its money into the
 * member's wallet account. An optional capability of the `funding` binding, found by `isFundingCreditPort` (as `FundingStatementPort`
 * and `MirrorPort` are), so it has no registry capability or flag of its own. Only the load id, the account reference, the amount and the
 * key cross the port: no name, mobile or memo (the adapter makes its own memo).
 *
 * The credit is per load: the key only makes a replay safe, a different key for a load already credited answers `credited` and moves
 * nothing more. A refusal is final for its key (the vendor's is), so a retry after a refusal needs a NEW key. Unknown outcome is
 * `pending`: retry with the SAME key, never a new one. `PROVIDER_UNAVAILABLE` means nothing moved and the call is safe to resend.
 * `amount` must be the load's own amount in USD, else `VALIDATION_FAILED`; an unknown `loadId` is `UNKNOWN_LOAD`.
 */
export interface FundingCreditPort {
  creditWallet(input: { loadId: string; accountRef: string; amount: Money }, idempotencyKey: string): Promise<CreditResult>;
}

/** True when the port a binding hands back also does the credit step (an optional capability, found by its method). */
export function isFundingCreditPort(port: unknown): port is FundingCreditPort {
  if (typeof port !== 'object' || port === null) return false;
  return typeof (port as Record<string, unknown>)['creditWallet'] === 'function';
}

export type FundingErrorCode = 'UNSUPPORTED_METHOD' | 'UNKNOWN_LOAD' | 'UNKNOWN_REFUND' | 'DECLINED' | 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class FundingError extends Error {
  readonly code: FundingErrorCode;
  constructor(
    code: FundingErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'FundingError';
  }
}

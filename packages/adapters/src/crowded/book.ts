// Crowded Book Payment, the shared call (T-0719; T-0704's `creditWallet` shares it). `POST /chapters/{id}/payments` with
// `type: book` is bulk (1 to 10 items), continue-on-error and answers HTTP 201 even for a refusal: the outcome of each item is in
// the item (`status: success | failed`, `paymentStatus: Sent | Pending | Rejected`, `errorCode`, `reasonCode`), never in the HTTP status.
// The body `idempotencyKey` is a UUID v4 scoped to the chapter (`bookWireKey`). Nothing here is retried: a caller that cannot tell
// whether a request landed reads it back (`GET .../payments`, matched by description) and never sends a new key.
// Crowded's text (descriptions, messages) is untrusted data. Nothing here puts a name, a mobile or an email in an error.
import { isRecord, str, uuidFromKey } from './map.ts';
import type { CrowdedClient } from './client.ts';

/** Crowded's wire amount: integer cents as a JSON number, so at most 2^53 - 1 (money inside is bigint, see `Money`). */
export type WireCents = number;

/** One payment of a book request. Amounts are cents as a safe integer (the caller refuses what JSON cannot carry). */
export interface BookItem {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: WireCents;
  /** At most 80 characters. */
  description: string;
  /** A UUID v4: `bookWireKey`. */
  idempotencyKey: string;
}

/** One item of the answer, as read: only what Crowded documents. */
export interface BookAnswer {
  index: number;
  status: string;
  paymentId?: string;
  paymentStatus?: string;
  errorCode?: string;
  reasonCode?: string;
}

/** The answer has a shape we do not know: the request may have booked, so the caller treats the outcome as unknown. */
export class BookShapeError extends Error {
  constructor() {
    super('Crowded answered the book request in a shape we do not know');
    this.name = 'BookShapeError';
  }
}

/** Our idempotency key as the UUID v4 Crowded wants (the live API refuses any other version, T-0734). Stable per key. */
export const bookWireKey = (key: string): string => uuidFromKey(`mirror:${key}`);

const opt = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);

/**
 * Sends the items and returns one answer per item, in the order sent. An item the answer does not mention (or mentions twice) is
 * missing from the map: the caller treats it as unknown. Throws `BookShapeError` when the answer is not a result list at all;
 * transport and HTTP errors are the client's own and surface unchanged.
 */
export async function postBookPayments(client: CrowdedClient, chapterId: string, items: BookItem[]): Promise<Map<number, BookAnswer>> {
  const r = await client.post(`/chapters/${chapterId}/payments`, { type: 'book', payments: items });
  const body = isRecord(r.data) ? r.data : undefined;
  const results = body && Array.isArray(body['results']) ? body['results'] : undefined;
  if (!results) throw new BookShapeError();
  const out = new Map<number, BookAnswer>();
  const dup = new Set<number>();
  results.forEach((x, position) => {
    if (!isRecord(x)) return;
    // The documented `index` is the position in our array; an answer without one is read by position when the counts agree.
    const index = typeof x['index'] === 'number' && Number.isInteger(x['index']) ? x['index'] : results.length === items.length ? position : -1;
    if (index < 0 || index >= items.length) return;
    if (out.has(index)) dup.add(index);
    const paymentId = opt(x['paymentId']);
    const paymentStatus = opt(x['paymentStatus']);
    const errorCode = opt(x['errorCode']);
    const reasonCode = opt(x['reasonCode']);
    out.set(index, { index, status: String(x['status']).toLowerCase(), ...(paymentId ? { paymentId } : {}), ...(paymentStatus ? { paymentStatus } : {}), ...(errorCode ? { errorCode } : {}), ...(reasonCode ? { reasonCode } : {}) });
  });
  for (const i of dup) out.delete(i);
  return out;
}

/** A book payment as `GET .../payments` and `GET .../payments/{id}` give it. */
export interface BookRow {
  id: string;
  /** `pending`, `processing`, `sent`, `failed` ... as the vendor says it, lower-cased. */
  status: string;
  /** Cents. A number, or an exact string past 2^53 - 1. */
  amount: unknown;
  description: string;
  sourceAccountId: string;
  destinationAccountId: string;
  createdAt: unknown;
  reasonCode?: string;
}

export function bookRow(v: unknown): BookRow | undefined {
  if (!isRecord(v)) return undefined;
  const accounts = isRecord(v['accounts']) ? v['accounts'] : undefined;
  if (!accounts) return undefined;
  const reasonCode = opt(v['reasonCode']);
  const description = typeof v['description'] === 'string' ? v['description'] : '';
  return { id: str(v['id']), status: String(v['status']).toLowerCase(), amount: v['amount'], description, sourceAccountId: str(accounts['sourceAccountId']), destinationAccountId: str(accounts['destinationAccountId']), createdAt: v['createdAt'], ...(reasonCode ? { reasonCode } : {}) };
}

/**
 * The chapter's book payments, newest first, across pages. The list has no total, so it stops at the first short or empty page. A
 * row the list shows twice (a payment made while we page pushes the older ones down) is yielded once. A row we cannot read is
 * skipped: it cannot be one of ours.
 */
export async function* listBookPayments(client: CrowdedClient, chapterId: string, pageSize = 100): AsyncGenerator<BookRow> {
  const seen = new Set<string>();
  for (let offset = 0; ; ) {
    const r = await client.get(`/chapters/${chapterId}/payments`, { 'filter[method]': 'book', 'pagination[limit]': pageSize, 'pagination[offset]': offset });
    const raw = Array.isArray(r.data) ? r.data : isRecord(r.data) && Array.isArray(r.data['payments']) ? r.data['payments'] : [];
    for (const x of raw) {
      let row: BookRow | undefined;
      try {
        row = bookRow(x);
      } catch {
        row = undefined;
      }
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      yield row;
    }
    offset += raw.length;
    // Crowded may cap a page below what we asked for: only an empty page ends the scan, never a short one.
    if (raw.length === 0) return;
  }
}

export async function getBookPayment(client: CrowdedClient, chapterId: string, paymentId: string): Promise<BookRow | undefined> {
  const r = await client.get(`/chapters/${chapterId}/payments/${paymentId}`);
  return bookRow(r.data);
}

// CrowdedMirror (T-0719, REQ-WAL-002, REQ-LED-004, ADR-018 M2): MirrorPort over Crowded's Book Payment. Flag: none of its own (it is an
// optional capability of the `funding` binding, wired by a later card).
//
// How the port's promises are kept on an API that gives less (live sandbox, 2026-11-11, docs/vendors/crowded/README.md):
// - A book payment is HTTP 201 whatever happens. The outcome is in the item: `paymentStatus` `Sent` is booked, `Rejected` is refused (even
//   though the item `status` says success), `Pending` or nothing readable is unknown. A `status: failed` item has no `paymentStatus`: it is
//   mapped by its `errorCode`. `DUPLICATE_PAYMENT` is never a final refusal: the adapter reads the payment back and answers what it became.
// - The wire key is a UUID v4 of ours (`bookWireKey('mirror:', key)`, from `uuidFromKey`), scoped to the chapter. It is derived, so a resend sends the same
//   one; it is not kept anywhere (the leg result has no slot for it, and `paymentRef` is the vendor's payment id).
// - The vendor has no lookup by key and no stored leg in the item, so a booked item's stored leg is read with `GET .../payments/{id}`: a
//   reused key with another body replays the FIRST payment and the caller compares `leg`. If that read fails the leg is `unknown`.
// - `readBack` lists the chapter's book payments (`filter[method]=book`, the vendor's order, which it does not rely on) and matches the memo as
//   sent, narrowed by the leg and bounded by `since` (a row older than `since` is skipped, the walk goes on). A refusal before persistence is never
//   listed, so it reads `not_found`; a listed `Rejected` payment (failed, canceled, returned) reads as refused; Pending is `unknown`. Whether the
//   vendor normalises or truncates a description is unknown: a miss is `not_found`, not proof that nothing booked. A list that stops paging
//   (a page with no new id) ends the walk: with no match found that is PROVIDER_UNAVAILABLE, never `not_found`.
// - Failures: a request that provably never left (429, 401, 403, or a failure before any write) is PROVIDER_UNAVAILABLE; a 400 or 422 is the
//   vendor refusing the whole request before processing (VALIDATION_FAILED); anything else after a write may have been sent (a timeout, a
//   5xx, a reset connection, an answer we cannot read) is OUTCOME_UNKNOWN. Reads fail PROVIDER_UNAVAILABLE. No retries here.
// - An account ref is `a:<id>` (a wallet account, T-0699); the chapter checking account is addressed by the chapter ref, and its Crowded
//   account id is found once per chapter. A ref of any other shape refuses that leg NOT_FOUND without a request. Amounts the JSON wire cannot
//   carry exactly (past 2^53 - 1 cents) refuse that leg VALIDATION_ERROR; balances past it are read as exact strings.
// - No name, mobile or vendor text is put in an error: messages are fixed. Descriptions are untrusted and are only ever compared or returned as data.
import { money, type Money } from '@kesher/domain';
import {
  MirrorError,
  isMirrorMemo,
  mirrorItemResult,
  validateMirrorBatch,
  type MirrorAccountStatus,
  type MirrorBalance,
  type MirrorDirection,
  type MirrorLeg,
  type MirrorLegResult,
  type MirrorMovement,
  type MirrorPayment,
  type MirrorPort,
  type MirrorReadBack,
  type MirrorStoredLeg,
} from '@kesher/ports';
import { bookWireKey, BookShapeError, getBookPayment, listBookPayments, postBookPayments, type BookAnswer, type BookItem, type BookRow } from './book.ts';
import { CrowdedApiError, type CrowdedClient } from './client.ts';
import { date, fromCents, fundingRef, isRecord, parseFundingRef, str } from './map.ts';

export interface CrowdedMirrorOptions {
  client: CrowdedClient;
  /** The platform chapter at Crowded: where members' wallet accounts live and the feeds are read. Required. */
  chapterId: string;
}

/** The namespace of this adapter's wire keys: a mirror leg and another caller's booking of one workflow id derive different keys. */
const MIRROR_KEY_PREFIX = 'mirror:';
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const low = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
const ACCOUNT_STATUS: Record<string, MirrorAccountStatus> = { open: 'open', frozen: 'frozen', closed: 'closed' };

export class CrowdedMirror implements MirrorPort {
  private readonly c: CrowdedClient;
  private readonly chapterId: string;
  private readonly checkingIds = new Map<string, string>();

  constructor(opts: CrowdedMirrorOptions) {
    if (!SAFE_ID.test(opts.chapterId ?? '')) throw new Error('CrowdedMirror needs the platform chapterId');
    this.c = opts.client;
    this.chapterId = opts.chapterId;
  }

  // ---- plumbing -----------------------------------------------------------------------------------------------

  /** A read: every failure is PROVIDER_UNAVAILABLE with fixed text (a 404 is NOT_FOUND when `missing`). */
  private async read<T>(fn: () => Promise<T>, missing = false): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MirrorError) throw e;
      if (missing && e instanceof CrowdedApiError && e.isMissing) throw new MirrorError('NOT_FOUND', 'Unknown account or chapter');
      throw new MirrorError('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
    }
  }

  private chapter(ref: string): string {
    if (typeof ref !== 'string' || !SAFE_ID.test(ref)) throw new MirrorError('NOT_FOUND', 'Unknown chapter');
    return ref;
  }

  /** The chapter checking account's Crowded id, found once. */
  private async checking(chapterRef: string): Promise<string> {
    const have = this.checkingIds.get(chapterRef);
    if (have) return have;
    const id = await this.read(async () => {
      let open: string | undefined;
      for await (const a of this.c.list(`/chapters/${chapterRef}/accounts`)) {
        if (isRecord(a) && low(a['product']) === 'checking' && low(a['status']) === 'open') {
          open = str(a['id']);
          break;
        }
      }
      return open;
    }, true);
    if (!id) throw new MirrorError('NOT_FOUND', 'The chapter has no open checking account');
    this.checkingIds.set(chapterRef, id);
    return id;
  }

  private accountOut(id: string, checking: string, chapterRef: string): string {
    return id === checking ? chapterRef : fundingRef('a', id);
  }

  private storedLeg(row: BookRow, checking: string): MirrorStoredLeg | undefined {
    const amount = fromCents(row.amount);
    if (row.sourceAccountId === checking) return { direction: 'from_checking', accountRef: fundingRef('a', row.destinationAccountId), amount, memo: row.description };
    if (row.destinationAccountId === checking) return { direction: 'to_checking', accountRef: fundingRef('a', row.sourceAccountId), amount, memo: row.description };
    return undefined;
  }

  private rowResult(row: BookRow, checking: string): MirrorLegResult {
    const leg = this.storedLeg(row, checking);
    const paymentStatus = row.status === 'sent' ? 'Sent' : ['failed', 'canceled', 'cancelled', 'returned', 'rejected'].includes(row.status) ? 'Rejected' : 'Pending';
    return mirrorItemResult({ paymentStatus, ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}), paymentRef: row.id, ...(leg ? { leg } : {}) });
  }

  // ---- bookBatch ----------------------------------------------------------------------------------------------

  async bookBatch(legs: MirrorLeg[], chapterRef: string): Promise<MirrorLegResult[]> {
    validateMirrorBatch(legs);
    const chapter = this.chapter(chapterRef);
    const checking = await this.checking(chapter);
    const results: (MirrorLegResult | undefined)[] = legs.map(() => undefined);
    const items: BookItem[] = [];
    const sent: number[] = [];
    legs.forEach((l, i) => {
      const member = parseFundingRef('a', l.accountRef);
      // The vendor never sees these: a ref that is no wallet account, a memo it would refuse, an amount JSON cannot carry exactly.
      if (member === undefined) results[i] = { status: 'refused', reasonCode: 'NOT_FOUND' };
      else if (!isMirrorMemo(l.memo) || l.amount.minor > SAFE) results[i] = { status: 'refused', reasonCode: 'VALIDATION_ERROR' };
      else {
        const out = l.direction === 'from_checking';
        items.push({ sourceAccountId: out ? checking : member, destinationAccountId: out ? member : checking, amount: Number(l.amount.minor), description: l.memo, idempotencyKey: bookWireKey(MIRROR_KEY_PREFIX, l.idempotencyKey) });
        sent.push(i);
      }
    });
    if (items.length > 0) {
      const answers = await this.send(chapter, items);
      for (const [n, i] of sent.entries()) results[i] = await this.resolve(chapter, checking, legs[i]!, answers.get(n));
    }
    return results.map((r) => r ?? { status: 'unknown' });
  }

  /** The one write. Where it fails decides the code: before processing is a refusal or unavailable, anywhere else the outcome is unknown. */
  private async send(chapter: string, items: BookItem[]): Promise<Map<number, BookAnswer>> {
    try {
      return await postBookPayments(this.c, chapter, items);
    } catch (e) {
      if (e instanceof BookShapeError) throw new MirrorError('OUTCOME_UNKNOWN', 'Crowded answered in a shape we do not know: read the legs back by memo before any resend');
      if (e instanceof CrowdedApiError) {
        if (e.status === 429 || e.isAuth) throw new MirrorError('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
        if (e.status === 400 || e.status === 422) throw new MirrorError('VALIDATION_FAILED', 'The funding provider refused the request');
        if (e.isMissing) throw new MirrorError('NOT_FOUND', 'Unknown account or chapter');
      }
      throw new MirrorError('OUTCOME_UNKNOWN', 'The request may have been sent: read the legs back by memo before any resend, with the same key');
    }
  }

  private async resolve(chapter: string, checking: string, leg: MirrorLeg, a: BookAnswer | undefined): Promise<MirrorLegResult> {
    if (!a) return { status: 'unknown' };
    if (a.status === 'failed') {
      if (a.errorCode === 'DUPLICATE_PAYMENT') return this.duplicate(chapter, leg);
      // A failed item has an `errorCode` and no `paymentStatus`: it is a refusal by that code (an unknown or missing one is PAYMENT_FAILED).
      return this.withLeg(chapter, checking, mirrorItemResult({ paymentStatus: 'Rejected', ...(a.errorCode ?? a.reasonCode ? { reasonCode: (a.errorCode ?? a.reasonCode)! } : {}), ...(a.paymentId ? { paymentRef: a.paymentId } : {}) }), a.paymentId);
    }
    if (a.status !== 'success') return { status: 'unknown', ...(a.paymentId ? { paymentRef: a.paymentId } : {}) };
    return this.withLeg(chapter, checking, mirrorItemResult({ paymentStatus: a.paymentStatus ?? '', ...(a.reasonCode ? { reasonCode: a.reasonCode } : {}), ...(a.paymentId ? { paymentRef: a.paymentId } : {}) }), a.paymentId);
  }

  /** Adds the stored leg the vendor holds. If it cannot be read the answer is unknown: the caller must compare a leg it cannot see. */
  private async withLeg(chapter: string, checking: string, base: MirrorLegResult, paymentId: string | undefined): Promise<MirrorLegResult> {
    if (!paymentId) return base;
    try {
      const row = await getBookPayment(this.c, chapter, paymentId);
      const leg = row ? this.storedLeg(row, checking) : undefined;
      if (leg) return { ...base, leg };
    } catch {
      // fall through
    }
    return { status: 'unknown', paymentRef: paymentId };
  }

  /** DUPLICATE_PAYMENT: the key was used before. Read the first payment back by memo and the leg; never a second movement. */
  private async duplicate(chapter: string, leg: MirrorLeg): Promise<MirrorLegResult> {
    try {
      const r = await this.readBack({ chapterRef: chapter, memo: leg.memo, accountRef: leg.accountRef, direction: leg.direction, amount: leg.amount });
      if (r.status === 'found') return r.result;
    } catch {
      // fall through
    }
    return { status: 'unknown' };
  }

  // ---- readBack -----------------------------------------------------------------------------------------------

  async readBack(input: { chapterRef: string; memo: string; accountRef?: string; direction?: MirrorDirection; amount?: Money; since?: Date }): Promise<MirrorReadBack> {
    const chapter = this.chapter(input.chapterRef);
    const checking = await this.checking(chapter);
    const member = input.accountRef === undefined ? undefined : parseFundingRef('a', input.accountRef);
    if (input.accountRef !== undefined && member === undefined) return { status: 'not_found' };
    const found = await this.read(async () => {
      const hits: MirrorLegResult[] = [];
      const state = { truncated: false };
      for await (const row of listBookPayments(this.c, chapter, { state })) {
        // The order is the vendor's, not ours to rely on: a row older than `since` is skipped, never the end of the walk.
        if (input.since && date(row.createdAt) < input.since) continue;
        if (row.description !== input.memo) continue;
        const stored = this.storedLeg(row, checking);
        if (!stored) continue;
        if (member !== undefined && stored.accountRef !== fundingRef('a', member)) continue;
        if (input.direction !== undefined && stored.direction !== input.direction) continue;
        if (input.amount !== undefined && (input.amount.currency !== 'USD' || stored.amount.minor !== input.amount.minor)) continue;
        hits.push(this.rowResult(row, checking));
      }
      // The list was cut short (a vendor that does not page): a miss proves nothing, so it is not "not_found" (a resend could double-book).
      if (state.truncated && hits.length === 0) throw new MirrorError('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
      return hits;
    });
    if (found.length === 0) return { status: 'not_found' };
    if (found.length === 1) return { status: 'found', result: found[0]! };
    return { status: 'ambiguous', candidates: found };
  }

  // ---- balances -----------------------------------------------------------------------------------------------

  private async balance(chapter: string, accountId: string): Promise<MirrorBalance> {
    return this.read(async () => {
      const r = await this.c.get(`/chapters/${chapter}/accounts/${accountId}`);
      const a = isRecord(r.data) ? r.data : {};
      // An unknown status is not spendable: it reads as frozen.
      return { status: ACCOUNT_STATUS[low(a['status'])] ?? 'frozen', balance: fromCents(a['balance']).minor, hold: fromCents(a['hold'] ?? 0).minor, available: fromCents(a['available'] ?? a['balance']).minor };
    }, true);
  }

  async checkingBalance(chapterRef: string): Promise<MirrorBalance> {
    const chapter = this.chapter(chapterRef);
    return this.balance(chapter, await this.checking(chapter));
  }

  async accountBalance(accountRef: string): Promise<MirrorBalance> {
    const id = parseFundingRef('a', accountRef);
    if (id === undefined) throw new MirrorError('NOT_FOUND', 'Unknown account');
    return this.balance(this.chapterId, id);
  }

  // ---- lists --------------------------------------------------------------------------------------------------

  async *payments(input: { chapterRef: string; from: Date; to: Date; since?: Date }): AsyncIterable<MirrorPayment> {
    const chapter = this.chapter(input.chapterRef);
    const checking = await this.checking(chapter);
    const lower = input.since && input.since > input.from ? input.since : input.from;
    // Buffered whole: an outage on a later page throws before anything is yielded (no partial list). The vendor lists newest first.
    const rows = await this.read(async () => {
      const out: MirrorPayment[] = [];
      const state = { truncated: false };
      for await (const row of listBookPayments(this.c, chapter, { state })) {
        const at = date(row.createdAt);
        if (at < lower) break;
        if (at >= input.to) continue;
        out.push({
          paymentRef: row.id,
          status: row.status === 'sent' ? 'sent' : ['failed', 'canceled', 'cancelled', 'returned', 'rejected'].includes(row.status) ? 'failed' : 'pending',
          amount: fromCents(row.amount),
          memo: row.description,
          sourceAccountRef: this.accountOut(row.sourceAccountId, checking, chapter),
          destinationAccountRef: this.accountOut(row.destinationAccountId, checking, chapter),
          createdAt: at,
        });
      }
      // A feed that was cut short is not the whole window: fail whole rather than hand a reconciler a partial list.
      if (state.truncated) throw new MirrorError('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
      return out;
    });
    yield* rows.reverse();
  }

  async *movements(input: { from: Date; to: Date }): AsyncIterable<MirrorMovement> {
    const checking = await this.checking(this.chapterId);
    const rows = await this.read(async () => {
      const out: MirrorMovement[] = [];
      const seen = new Set<string>();
      for await (const t of this.c.list(`/chapters/${this.chapterId}/transactions`, { 'filter[createdAt][min]': input.from.toISOString(), 'filter[createdAt][max]': input.to.toISOString() })) {
        if (!isRecord(t) || low(t['type']) !== 'booktransaction') continue;
        const id = str(t['id']);
        const at = date(t['createdAt']);
        if (seen.has(id) || at < input.from || at >= input.to) continue;
        seen.add(id);
        const amount = fromCents(t['amount']);
        const cp = isRecord(t['counterparty']) && t['counterparty']['accountId'] !== undefined ? str(t['counterparty']['accountId']) : undefined;
        out.push({
          transactionRef: fundingRef('t', id),
          accountRef: this.accountOut(str(t['accountId']), checking, this.chapterId),
          direction: low(t['direction']) === 'debit' ? 'debit' : 'credit',
          amount: money(amount.minor < 0n ? -amount.minor : amount.minor, 'USD'),
          ...(cp ? { counterpartyAccountRef: this.accountOut(cp, checking, this.chapterId) } : {}),
          description: typeof t['title'] === 'string' ? t['title'].slice(0, 200) : '',
          at,
        });
      }
      return out;
    });
    yield* rows;
  }
}

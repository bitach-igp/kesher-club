// TransferService (T-0205): the single writer of ops.transfer. Every state change is one
// transaction that updates the row, appends a transfer_event, and enqueues an outbox message.
// Money moves only through the ledger (journal ids are recorded here, never amounts recomputed).
import { DomainError, uuidv7, type Currency, type Money } from '@kesher/domain';
import type { Market } from '@kesher/ports';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';
import { enqueue } from './outbox.ts';
import { next, TERMINAL_STATES, type TransferEvent, type TransferState } from './state-machine.ts';

export type TransferKind = 'p2p' | 'load' | 'payout' | 'fx' | 'allowance' | 'addon' | 'refund' | 'fee';

/**
 * The received leg of a cross-currency send (T-0515, REQ-PAY-006): priced once at create time from the
 * club rate in force, so a replay or the hold's release never re-prices (ADR-007).
 */
export interface TransferConversion {
  received: Money;
  rateId: string;
  rateVersion: number;
  /** Received-currency units per one unit sent × 1e6, in the direction used. */
  rateScaled: bigint;
  markupBps: bigint;
}

export interface Transfer {
  id: string;
  idempotencyKey: string;
  kind: TransferKind;
  fromPartyId?: string;
  toPartyId?: string;
  amount: Money;
  state: TransferState;
  holdReleasesAt?: string;
  failureCode?: string;
  journalId?: string;
  reversalJournalId?: string;
  note?: string;
  conversion?: TransferConversion;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTransferInput {
  idempotencyKey: string;
  kind: TransferKind;
  fromPartyId?: string;
  toPartyId?: string;
  amount: Money;
  note?: string;
  conversion?: TransferConversion;
}

interface Row {
  id: string;
  idempotency_key: string;
  kind: TransferKind;
  from_party_id: string | null;
  to_party_id: string | null;
  amount_minor: string;
  currency: Currency;
  state: TransferState;
  hold_releases_at: string | Date | null;
  failure_code: string | null;
  journal_id: string | null;
  reversal_journal_id: string | null;
  note: string | null;
  received_minor: string | null;
  received_currency: Currency | null;
  fx_rate_id: string | null;
  fx_rate_version: number | null;
  fx_rate_scaled: string | null;
  fx_markup_bps: number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export class TransferService {
  private readonly db: Database;
  /** The market whose API this is: every row written carries it (T-0027), and the worker's sweeps read
   *  only its rows (T-0028). createApp always passes it. */
  readonly market: Market;
  constructor(db: Database, market: Market = 'IL') {
    this.db = db;
    this.market = market;
  }

  /** Idempotent by key: a replayed create returns the existing transfer unchanged (REQ-PAY-005). */
  async create(input: CreateTransferInput, now: Date): Promise<Transfer> {
    if (input.amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
    const c = input.conversion;
    if (c && (c.received.minor <= 0n || c.received.currency === input.amount.currency || c.markupBps < 0n || c.rateScaled <= 0n)) throw new DomainError('VALIDATION_FAILED', 'A conversion receives a positive amount in the other currency');
    const existing = await this.byKey(input.idempotencyKey);
    if (existing) return existing;
    const id = uuidv7(now);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `insert into ops.transfer (id, idempotency_key, kind, from_party_id, to_party_id, amount_minor, currency, state, note, received_minor, received_currency, fx_rate_id, fx_rate_version, fx_rate_scaled, fx_markup_bps, created_at, updated_at, market)
           values ($1, $2, $3, $4, $5, $6, $7, 'created', $8, $9, $10, $11, $12, $13, $14, $15, $15, $16)`,
          [id, input.idempotencyKey, input.kind, input.fromPartyId ?? null, input.toPartyId ?? null, input.amount.minor.toString(), input.amount.currency, input.note ?? null, c?.received.minor.toString() ?? null, c?.received.currency ?? null, c?.rateId ?? null, c?.rateVersion ?? null, c?.rateScaled.toString() ?? null, c ? Number(c.markupBps) : null, now, this.market],
        );
        await tx.query('insert into ops.transfer_event (transfer_id, from_state, to_state, at) values ($1, null, $2, $3)', [id, 'created', now]);
        await enqueue(tx, 'transfer', id, 'transfer.created', { kind: input.kind, amount: input.amount, fromPartyId: input.fromPartyId, toPartyId: input.toPartyId, ...(c ? { received: c.received, rateVersion: c.rateVersion } : {}) });
      });
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return (await this.byKey(input.idempotencyKey))!;
      throw e;
    }
    return (await this.byKey(input.idempotencyKey))!;
  }

  /**
   * Applies one event. Optional fields land with the state: the journal for settle, the release time
   * for hold, a failure code for fail, the reversal journal for reverse. Idempotent for an already
   * applied event when `expectFrom` is omitted and the row is already in the target state.
   */
  async apply(id: string, event: TransferEvent, now: Date, extra: { journalId?: string; reversalJournalId?: string; holdReleasesAt?: Date; failureCode?: string; reason?: string } = {}): Promise<Transfer> {
    return this.db.transaction(async (tx) => {
      const row = await tx.query<Row>('select * from ops.transfer where id = $1 for update', [id]);
      const t = row.rows[0];
      if (!t) throw new DomainError('NOT_FOUND', 'Transfer not found');
      const to = next(t.state, event);
      await tx.query(
        `update ops.transfer set state = $2, journal_id = coalesce($3, journal_id), reversal_journal_id = coalesce($4, reversal_journal_id),
                hold_releases_at = $5, failure_code = coalesce($6, failure_code), updated_at = $7 where id = $1`,
        [id, to, extra.journalId ?? null, extra.reversalJournalId ?? null, to === 'pending_hold' ? (extra.holdReleasesAt ?? null) : null, extra.failureCode ?? null, now],
      );
      await tx.query('insert into ops.transfer_event (transfer_id, from_state, to_state, reason, at) values ($1, $2, $3, $4, $5)', [id, t.state, to, extra.reason ?? null, now]);
      await enqueue(tx, 'transfer', id, `transfer.${to}`, { from: t.state, kind: t.kind, amount: { minor: t.amount_minor, currency: t.currency }, ...(extra.failureCode ? { failureCode: extra.failureCode } : {}), ...(extra.holdReleasesAt ? { holdReleasesAt: extra.holdReleasesAt.toISOString() } : {}) });
      return (await this.get(id, tx))!;
    });
  }

  async get(id: string, db: SqlClient = this.db): Promise<Transfer | undefined> {
    const r = await db.query<Row>('select * from ops.transfer where id = $1', [id]);
    return r.rows[0] ? toTransfer(r.rows[0]) : undefined;
  }

  async byKey(key: string): Promise<Transfer | undefined> {
    const r = await this.db.query<Row>('select * from ops.transfer where idempotency_key = $1', [key]);
    return r.rows[0] ? toTransfer(r.rows[0]) : undefined;
  }

  /** Holds whose 2 h window passed (REQ-PAY-003); the workflow releases them. */
  async expiredHolds(now: Date): Promise<Transfer[]> {
    const r = await this.db.query<Row>(`select * from ops.transfer where state = 'pending_hold' and hold_releases_at <= $1 and market = $2 order by hold_releases_at`, [now, this.market]);
    return r.rows.map(toTransfer);
  }

  async history(id: string): Promise<{ from?: TransferState; to: TransferState; reason?: string; at: string }[]> {
    const r = await this.db.query<{ from_state: TransferState | null; to_state: TransferState; reason: string | null; at: string | Date }>('select from_state, to_state, reason, at from ops.transfer_event where transfer_id = $1 order by id', [id]);
    return r.rows.map((e) => ({ ...(e.from_state ? { from: e.from_state } : {}), to: e.to_state, ...(e.reason ? { reason: e.reason } : {}), at: new Date(e.at).toISOString() }));
  }

  isTerminal(t: Transfer): boolean {
    return TERMINAL_STATES.has(t.state);
  }
}

function toTransfer(r: Row): Transfer {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    kind: r.kind,
    ...(r.from_party_id ? { fromPartyId: r.from_party_id } : {}),
    ...(r.to_party_id ? { toPartyId: r.to_party_id } : {}),
    amount: { minor: BigInt(r.amount_minor), currency: r.currency },
    state: r.state,
    ...(r.hold_releases_at ? { holdReleasesAt: new Date(r.hold_releases_at).toISOString() } : {}),
    ...(r.failure_code ? { failureCode: r.failure_code } : {}),
    ...(r.journal_id ? { journalId: r.journal_id } : {}),
    ...(r.reversal_journal_id ? { reversalJournalId: r.reversal_journal_id } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.received_minor && r.received_currency && r.fx_rate_id && r.fx_rate_version !== null && r.fx_rate_scaled && r.fx_markup_bps !== null
      ? { conversion: { received: { minor: BigInt(r.received_minor), currency: r.received_currency }, rateId: r.fx_rate_id, rateVersion: r.fx_rate_version, rateScaled: BigInt(r.fx_rate_scaled), markupBps: BigInt(r.fx_markup_bps) } }
      : {}),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

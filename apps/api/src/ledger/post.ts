// Ledger core on Postgres (T-0201, REQ-LED-001/002/003): the reference Ledger from @kesher/domain
// ported to ledger.journal / ledger.posting with the balance cache in ops.account_balance. Insert-only; the deferred
// trigger ledger.assert_balanced() is the last line of defence; the balance cache is the one
// UPDATE the app role may run. Same idempotency key → the original journal, always.
import { DomainError, uuidv7, type Currency, type Posting } from '@kesher/domain';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';

export interface JournalInput {
  idempotencyKey: string;
  kind: string;
  postings: readonly Posting[];
  effectiveAt?: Date;
  transferId?: string;
  metadata?: Record<string, unknown>;
  reversesId?: string;
}

export interface PostedJournal {
  id: string;
  idempotencyKey: string;
  kind: string;
  postings: readonly Posting[];
  reversesId?: string;
  transferId?: string;
  effectiveAt: string;
}

interface JournalRow {
  id: string;
  idempotency_key: string;
  kind: string;
  reverses_id: string | null;
  transfer_id: string | null;
  effective_at: string | Date;
}
interface PostingRow {
  account_id: string;
  currency: Currency;
  amount_minor: string | bigint | number;
}

export class PostgresLedger {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async post(input: JournalInput): Promise<PostedJournal> {
    return this.write(input);
  }

  /**
   * Posts like `post`, but a member wallet the journal DEBITS is locked and checked inside the posting transaction (T-0544, F13):
   * its balance after the journal may not be below zero, otherwise INSUFFICIENT_FUNDS with `available` and `currency`. The check
   * comes after the idempotency replay (a replayed key answers its first journal whatever the wallet holds now) and after the lock,
   * so two requests for one wallet are serialised and exactly one of two full-balance debits succeeds. Locks are taken in account-id
   * order, so journals touching the same wallets cannot deadlock. `extraGuard` runs under the same locks, before anything is
   * written (a limit that must hold across parallel requests). A caller must not hold the lock across a vendor call: the
   * transaction is only the check and the writes.
   */
  async postNoOverdraft(input: JournalInput, extraGuard?: (tx: SqlClient) => Promise<void>): Promise<PostedJournal> {
    const debited = [...new Set(input.postings.filter((x) => x.amountMinor > 0n).map((x) => x.accountId))].sort();
    return this.write(input, async (tx) => {
      for (const id of debited) await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wallet:${id}`]);
      // The key may have been posted while this request waited for the lock: that journal is the answer, no check, no second write.
      if (await this.findByKey(tx, input.idempotencyKey)) return false;
      if (debited.length > 0) {
        const rows = await tx.query<{ id: string; type: string; currency: Currency; balance: string }>(
          `select a.id::text as id, a.type::text as type, a.currency::text as currency, coalesce(b.balance_minor, 0)::text as balance
             from ledger.account a left join ops.account_balance b on b.account_id = a.id where a.id = any($1::uuid[])`,
          [debited],
        );
        for (const r of rows.rows) {
          if (r.type !== 'wallet') continue;
          const debit = input.postings.filter((x) => x.accountId === r.id).reduce((n, x) => n + x.amountMinor, 0n);
          const balance = BigInt(r.balance);
          if (balance + debit > 0n) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the wallet for this journal', { available: (balance < 0n ? -balance : 0n).toString(), currency: r.currency });
        }
      }
      if (extraGuard) await extraGuard(tx);
      return true;
    });
  }

  private async write(input: JournalInput, guard?: (tx: SqlClient) => Promise<boolean>): Promise<PostedJournal> {
    validate(input);
    const existing = await this.findByKey(this.db, input.idempotencyKey);
    if (existing) return existing;
    const id = uuidv7();
    try {
      await this.db.transaction(async (tx) => {
        if (guard && !(await guard(tx))) return;
        if (input.reversesId) {
          const target = await tx.query('select 1 from ledger.journal where id = $1', [input.reversesId]);
          if (target.rowCount === 0) throw new DomainError('NOT_FOUND', 'Reversal target missing');
        }
        await tx.query(
          `insert into ledger.journal (id, idempotency_key, kind, transfer_id, reverses_id, effective_at, metadata)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, input.idempotencyKey, input.kind, input.transferId ?? null, input.reversesId ?? null, input.effectiveAt ?? new Date(), JSON.stringify(input.metadata ?? {})],
        );
        // The postings go in as given; the balance rows are then updated in account-id order. Two journals touching the same pair of
        // accounts in opposite orders would otherwise take the balance row locks in opposite orders and deadlock (40P01).
        const lastPosting = new Map<string, string>();
        for (const p of input.postings) {
          const r = await tx.query<{ id: string }>(
            `insert into ledger.posting (journal_id, account_id, currency, amount_minor) values ($1, $2, $3, $4) returning id::text as id`,
            [id, p.accountId, p.currency, p.amountMinor.toString()],
          );
          lastPosting.set(p.accountId, r.rows[0]!.id);
        }
        for (const p of [...input.postings].sort((x, y) => (x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : 0))) {
          await tx.query(
            `insert into ops.account_balance (account_id, balance_minor, last_posting_id, version) values ($1, $2, $3, 1)
             on conflict (account_id) do update
               set balance_minor = ops.account_balance.balance_minor + excluded.balance_minor,
                   last_posting_id = excluded.last_posting_id,
                   version = ops.account_balance.version + 1`,
            [p.accountId, p.amountMinor.toString(), lastPosting.get(p.accountId)!],
          );
        }
      });
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) {
        if (e.constraint?.includes('idempotency_key') || e.detail?.includes('idempotency_key')) {
          const winner = await this.findByKey(this.db, input.idempotencyKey);
          if (winner) return winner;
        }
        if (e.constraint?.includes('reverses_id') || e.detail?.includes('reverses_id')) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Journal already reversed');
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'Duplicate posting in journal');
      }
      if (isPgError(e, PG.RAISE_EXCEPTION) && /UNBALANCED/.test(e.message)) throw new DomainError('UNBALANCED', 'Journal does not balance per currency');
      throw e;
    }
    return (await this.findByKey(this.db, input.idempotencyKey))!;
  }

  /**
   * Reverses exactly once by posting the negated postings (invariant 4). Idempotent by key. The reversal belongs to the original's transfer
   * (so it shows with it) and takes the original's effective time unless the caller names one (T-0552).
   */
  async reverse(journalId: string, idempotencyKey: string, opts: { effectiveAt?: Date } = {}): Promise<PostedJournal> {
    const target = await this.findById(journalId);
    if (!target) throw new DomainError('NOT_FOUND', 'Journal not found');
    return this.post({
      idempotencyKey,
      kind: 'reversal',
      reversesId: journalId,
      ...(target.transferId ? { transferId: target.transferId } : {}),
      effectiveAt: opts.effectiveAt ?? new Date(target.effectiveAt),
      postings: target.postings.map((p) => ({ ...p, amountMinor: -p.amountMinor })),
    });
  }

  async balance(accountId: string, currency: Currency): Promise<bigint> {
    const r = await this.db.query<{ balance_minor: string | bigint; currency: Currency }>(
      `select b.balance_minor::text as balance_minor, a.currency from ops.account_balance b join ledger.account a on a.id = b.account_id where b.account_id = $1`,
      [accountId],
    );
    const row = r.rows[0];
    if (!row) return 0n;
    if (row.currency !== currency) throw new DomainError('VALIDATION_FAILED', `Account is ${row.currency}, not ${currency}`);
    return BigInt(row.balance_minor);
  }

  /** Sum of every balance per currency; must be zero (invariant 1). */
  async totals(): Promise<Map<Currency, bigint>> {
    const r = await this.db.query<{ currency: Currency; total: string }>(`select currency, coalesce(sum(amount_minor), 0)::text as total from ledger.posting group by currency`);
    return new Map(r.rows.map((x) => [x.currency, BigInt(x.total)]));
  }

  private async findByKey(db: SqlClient, key: string): Promise<PostedJournal | undefined> {
    const j = await db.query<JournalRow>('select id, idempotency_key, kind, reverses_id, transfer_id, effective_at from ledger.journal where idempotency_key = $1', [key]);
    return j.rows[0] ? this.hydrate(db, j.rows[0]) : undefined;
  }

  private async findById(id: string): Promise<PostedJournal | undefined> {
    const j = await this.db.query<JournalRow>('select id, idempotency_key, kind, reverses_id, transfer_id, effective_at from ledger.journal where id = $1', [id]);
    return j.rows[0] ? this.hydrate(this.db, j.rows[0]) : undefined;
  }

  private async hydrate(db: SqlClient, row: JournalRow): Promise<PostedJournal> {
    const p = await db.query<PostingRow>('select account_id, currency, amount_minor::text as amount_minor from ledger.posting where journal_id = $1 order by id', [row.id]);
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      postings: p.rows.map((x) => ({ accountId: x.account_id, currency: x.currency, amountMinor: BigInt(x.amount_minor) })),
      ...(row.reverses_id ? { reversesId: row.reverses_id } : {}),
      ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
      effectiveAt: new Date(row.effective_at).toISOString(),
    };
  }
}

function validate(input: JournalInput): void {
  if (input.postings.length < 2) throw new DomainError('UNBALANCED', 'A journal needs at least two postings');
  const sums = new Map<Currency, bigint>();
  const seen = new Set<string>();
  for (const p of input.postings) {
    if (p.amountMinor === 0n) throw new DomainError('VALIDATION_FAILED', 'Zero posting');
    if (seen.has(p.accountId)) throw new DomainError('VALIDATION_FAILED', 'One posting per account per journal');
    seen.add(p.accountId);
    sums.set(p.currency, (sums.get(p.currency) ?? 0n) + p.amountMinor);
  }
  for (const [cur, s] of sums) if (s !== 0n) throw new DomainError('UNBALANCED', `Journal does not balance in ${cur} by ${s}`);
}

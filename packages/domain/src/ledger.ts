// Reference ledger: the in-memory model of ledger.journal / ledger.posting.
// The Postgres implementation (T-0201) must pass the same property tests.

import { DomainError } from './errors.ts';
import type { Currency } from './money.ts';

export interface Posting {
  readonly accountId: string;
  readonly currency: Currency;
  /** +debit / -credit, minor units, never zero. */
  readonly amountMinor: bigint;
}

export interface Journal {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly postings: readonly Posting[];
  readonly reversesId?: string;
}

export class Ledger {
  private readonly journals = new Map<string, Journal>();
  private readonly byKey = new Map<string, Journal>();
  private readonly reversed = new Set<string>();
  private readonly balances = new Map<string, bigint>();
  private seq = 0;

  /** Posts a journal atomically. Same idempotency key returns the original (REQ-LED-003). */
  post(input: Omit<Journal, 'id'>): Journal {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing;

    if (input.postings.length < 2) throw new DomainError('UNBALANCED', 'A journal needs at least two postings');
    const sums = new Map<Currency, bigint>();
    for (const p of input.postings) {
      if (p.amountMinor === 0n) throw new DomainError('VALIDATION_FAILED', 'Zero posting');
      sums.set(p.currency, (sums.get(p.currency) ?? 0n) + p.amountMinor);
    }
    for (const [cur, s] of sums) {
      if (s !== 0n) throw new DomainError('UNBALANCED', `Journal does not balance in ${cur} by ${s}`);
    }
    if (input.reversesId !== undefined) {
      if (!this.journals.has(input.reversesId)) throw new DomainError('NOT_FOUND', 'Reversal target missing');
      if (this.reversed.has(input.reversesId)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Journal already reversed');
    }

    const journal: Journal = { ...input, id: `j_${++this.seq}` };
    this.journals.set(journal.id, journal);
    this.byKey.set(journal.idempotencyKey, journal);
    if (journal.reversesId !== undefined) this.reversed.add(journal.reversesId);
    for (const p of journal.postings) {
      const k = `${p.accountId}|${p.currency}`;
      this.balances.set(k, (this.balances.get(k) ?? 0n) + p.amountMinor);
    }
    return journal;
  }

  /** Reverses exactly once by posting the negated postings (invariant 4). */
  reverse(journalId: string, idempotencyKey: string): Journal {
    const target = this.journals.get(journalId);
    if (!target) throw new DomainError('NOT_FOUND', 'Journal not found');
    return this.post({
      idempotencyKey,
      kind: 'reversal',
      reversesId: journalId,
      postings: target.postings.map((p) => ({ ...p, amountMinor: -p.amountMinor })),
    });
  }

  balance(accountId: string, currency: Currency): bigint {
    return this.balances.get(`${accountId}|${currency}`) ?? 0n;
  }

  /** Sum of every balance per currency; must always be zero (invariant 1, system-wide). */
  totals(): Map<Currency, bigint> {
    const out = new Map<Currency, bigint>();
    for (const [k, v] of this.balances) {
      const cur = k.slice(k.lastIndexOf('|') + 1) as Currency;
      out.set(cur, (out.get(cur) ?? 0n) + v);
    }
    return out;
  }

  journalCount(): number {
    return this.journals.size;
  }
}

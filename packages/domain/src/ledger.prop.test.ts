// TST-LED-001 and TST-LED-003, plus invariants 1, 3 and 4 from Tab 3 §6.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Ledger, type Posting } from './ledger.ts';
import { DomainError } from './errors.ts';

const accounts = ['wallet:noa', 'wallet:dani', 'partner_settlement', 'fee_income', 'fx_position'];

/** A balanced journal: n random legs plus one balancing leg, per currency. */
const balancedPostings = fc
  .tuple(
    fc.constantFrom('USD' as const, 'ILS' as const),
    fc.array(fc.tuple(fc.constantFrom(...accounts), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.boolean()), { minLength: 1, maxLength: 4 }),
    fc.constantFrom(...accounts),
  )
  .map(([currency, legs, balancer]): Posting[] => {
    const postings: Posting[] = legs.map(([accountId, amt, debit]) => ({ accountId, currency, amountMinor: debit ? amt : -amt }));
    const total = postings.reduce((s, p) => s + p.amountMinor, 0n);
    if (total !== 0n) postings.push({ accountId: balancer, currency, amountMinor: -total });
    return postings;
  });

describe('ledger invariants', () => {
  it('every accepted journal leaves system totals at zero per currency', () => {
    fc.assert(fc.property(fc.array(balancedPostings, { maxLength: 40 }), (journals) => {
      const l = new Ledger();
      journals.forEach((postings, i) => {
        if (postings.length >= 2) l.post({ idempotencyKey: `k${i}`, kind: 'test', postings });
      });
      for (const [, t] of l.totals()) expect(t).toBe(0n);
    }));
  });

  it('rejects an unbalanced journal and writes nothing (REQ-LED-001)', () => {
    const l = new Ledger();
    expect(() =>
      l.post({
        idempotencyKey: 'bad',
        kind: 'load',
        postings: [
          { accountId: 'wallet:noa', currency: 'USD', amountMinor: 100n },
          { accountId: 'partner_settlement', currency: 'USD', amountMinor: -99n },
        ],
      }),
    ).toThrow(DomainError);
    expect(l.journalCount()).toBe(0);
    expect(l.balance('wallet:noa', 'USD')).toBe(0n);
  });

  it('replaying the same idempotency keys yields identical balances (REQ-LED-003)', () => {
    fc.assert(fc.property(fc.array(balancedPostings, { minLength: 1, maxLength: 20 }), (journals) => {
      const once = new Ledger();
      const twice = new Ledger();
      const valid = journals.filter((p) => p.length >= 2);
      valid.forEach((postings, i) => once.post({ idempotencyKey: `k${i}`, kind: 't', postings }));
      for (let r = 0; r < 2; r++) valid.forEach((postings, i) => twice.post({ idempotencyKey: `k${i}`, kind: 't', postings }));
      for (const a of accounts) for (const c of ['USD', 'ILS'] as const) expect(twice.balance(a, c)).toBe(once.balance(a, c));
      expect(twice.journalCount()).toBe(once.journalCount());
    }));
  });

  it('a reversal restores balances and can happen only once', () => {
    fc.assert(fc.property(balancedPostings.filter((p) => p.length >= 2), (postings) => {
      const l = new Ledger();
      const j = l.post({ idempotencyKey: 'a', kind: 'p2p', postings });
      l.reverse(j.id, 'rev-a');
      for (const a of accounts) for (const c of ['USD', 'ILS'] as const) expect(l.balance(a, c)).toBe(0n);
      expect(() => l.reverse(j.id, 'rev-a-2')).toThrow(DomainError);
    }));
  });
});

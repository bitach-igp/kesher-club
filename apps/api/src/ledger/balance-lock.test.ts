// T-0544 (REQ-WAL-001, REQ-PAY-002, REQ-CRD-003, F13): a journal that debits a member's wallet locks it and checks the
// balance inside the posting transaction, after the idempotency replay. PGlite is one connection, so this file proves the
// rule (the check, the replay, what is and is not guarded); the race itself runs on real Postgres in balance-lock.pg.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Currency, type Posting } from '@kesher/domain';
import { PostgresLedger } from './post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
const acct: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  for (const [name, type, currency] of [
    ['wallet:a', 'wallet', 'USD'],
    ['wallet:b', 'wallet', 'USD'],
    ['wallet:a:ils', 'wallet', 'ILS'],
    ['pending:a', 'pending', 'USD'],
    ['partner', 'partner_settlement', 'USD'],
    ['partner:ils', 'partner_settlement', 'ILS'],
    ['fee', 'fee_income', 'USD'],
  ] as const) {
    const id = uuidv7();
    acct[name] = id;
    await db.query(`insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, $4, $5)`, [id, name.startsWith('wallet') || name.startsWith('pending') ? uuidv7() : null, type, currency, type === 'wallet' || type === 'pending' ? 'C' : 'D']);
  }
  await ledger.post({ idempotencyKey: 'fund-a', kind: 'load', postings: [p('partner', 10_000n), p('wallet:a', -10_000n)] });
}, 60_000);
afterAll(async () => db.close());

const p = (name: string, amountMinor: bigint, currency: Currency = 'USD'): Posting => ({ accountId: acct[name]!, currency, amountMinor });
const bal = (name: string, currency: Currency = 'USD') => ledger.balance(acct[name]!, currency);

describe('PostgresLedger.postNoOverdraft (T-0544)', () => {
  it('lets a debit that fits through and refuses one that would overdraw, posting nothing, with the available amount', async () => {
    const ok = await ledger.postNoOverdraft({ idempotencyKey: 'nl-1', kind: 'p2p', postings: [p('wallet:a', 6_000n), p('wallet:b', -6_000n)] });
    expect(ok.postings).toHaveLength(2);
    expect(await bal('wallet:a')).toBe(-4_000n);
    await expect(ledger.postNoOverdraft({ idempotencyKey: 'nl-2', kind: 'p2p', postings: [p('wallet:a', 4_001n), p('wallet:b', -4_001n)] })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', extra: { available: '4000', currency: 'USD' } });
    expect(await bal('wallet:a')).toBe(-4_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = 'nl-2'`)).rows[0]!.n).toBe(0);
    // Exactly the whole balance is fine.
    await ledger.postNoOverdraft({ idempotencyKey: 'nl-3', kind: 'p2p', postings: [p('wallet:a', 4_000n), p('wallet:b', -4_000n)] });
    expect(await bal('wallet:a')).toBe(0n);
  });

  it('a replay of an already posted key answers the first journal, even though the wallet is empty now', async () => {
    const again = await ledger.postNoOverdraft({ idempotencyKey: 'nl-1', kind: 'p2p', postings: [p('wallet:a', 6_000n), p('wallet:b', -6_000n)] });
    expect(again.idempotencyKey).toBe('nl-1');
    expect(await bal('wallet:a')).toBe(0n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = 'nl-1'`)).rows[0]!.n).toBe(1);
  });

  it('guards only a member wallet that is debited: credits, reversals, pending and system accounts are not refused', async () => {
    // A credit to the empty wallet, and a pending → wallet move, are never an overdraw.
    await ledger.postNoOverdraft({ idempotencyKey: 'nl-4', kind: 'load', postings: [p('partner', 500n), p('wallet:a', -500n)] });
    await ledger.postNoOverdraft({ idempotencyKey: 'nl-5', kind: 'p2p_release', postings: [p('pending:a', 100n), p('wallet:a', -100n)] }); // pending is a system-side move here, not guarded
    // Debiting a system account below zero (partner is debit-normal) is fine.
    await ledger.postNoOverdraft({ idempotencyKey: 'nl-6', kind: 'x', postings: [p('fee', 50n), p('pending:a', -50n)] });
    // A reversal of a wallet debit credits the wallet.
    const j = await ledger.postNoOverdraft({ idempotencyKey: 'nl-7', kind: 'p2p', postings: [p('wallet:a', 300n), p('wallet:b', -300n)] });
    const rev = await ledger.reverse(j.id, 'nl-7:reversal');
    expect(rev.kind).toBe('reversal');
    expect(await bal('wallet:a')).toBe(-600n);
  });

  it('checks each currency\'s wallet on its own: a debit of the shekel wallet does not borrow from the dollar one', async () => {
    await expect(ledger.postNoOverdraft({ idempotencyKey: 'nl-8', kind: 'fx', postings: [p('wallet:a:ils', 1n, 'ILS'), p('partner:ils', -1n, 'ILS')] })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', extra: { available: '0', currency: 'ILS' } });
  });

  it('a journal that debits one wallet and credits another keeps the books balanced and moves exactly the amount', async () => {
    const before = await bal('wallet:b');
    await ledger.postNoOverdraft({ idempotencyKey: 'nl-9', kind: 'p2p', postings: [p('wallet:a', 100n), p('wallet:b', -100n)] });
    expect((await bal('wallet:b')) - before).toBe(-100n);
    expect((await ledger.totals()).get('USD')).toBe(0n);
  });
});

// TST-LED-001, TST-LED-002, TST-LED-003 against real Postgres (PGlite + db/migrations/ledger).
// The in-memory reference Ledger (@kesher/domain) is the oracle for the property test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DomainError, Ledger, uuidv7, type Currency, type Posting } from '@kesher/domain';
import { PostgresLedger } from './post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
const acct: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  for (const [name, type, currency] of [
    ['wallet:noa', 'wallet', 'USD'],
    ['wallet:dani', 'wallet', 'USD'],
    ['wallet:noa:ils', 'wallet', 'ILS'],
    ['partner_settlement', 'partner_settlement', 'USD'],
    ['partner_settlement:ils', 'partner_settlement', 'ILS'],
    ['fee_income', 'fee_income', 'USD'],
  ] as const) {
    const id = uuidv7();
    acct[name] = id;
    await db.query(`insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, $4, $5)`, [id, name.startsWith('wallet') ? uuidv7() : null, type, currency, type === 'wallet' ? 'C' : 'D']);
  }
}, 60_000);
afterAll(async () => db.close());

const p = (name: string, amountMinor: bigint, currency: Currency = 'USD'): Posting => ({ accountId: acct[name]!, currency, amountMinor });

describe('PostgresLedger.post()', () => {
  it('posts a balanced journal and materialises balances (REQ-LED-001)', async () => {
    const j = await ledger.post({ idempotencyKey: 'load-1', kind: 'load', postings: [p('partner_settlement', 10_000n), p('wallet:noa', -10_000n)] });
    expect(j.postings.length).toBe(2);
    expect(await ledger.balance(acct['wallet:noa']!, 'USD')).toBe(-10_000n);
    expect(await ledger.balance(acct['partner_settlement']!, 'USD')).toBe(10_000n);
  });

  it('rejects an unbalanced journal with UNBALANCED and writes nothing: +100 / −99 USD (TST-LED-001)', async () => {
    const before = await db.query<{ n: string }>('select count(*)::text as n from ledger.journal');
    await expect(ledger.post({ idempotencyKey: 'bad-1', kind: 'load', postings: [p('wallet:noa', 100n), p('partner_settlement', -99n)] })).rejects.toMatchObject({ code: 'UNBALANCED' });
    const after = await db.query<{ n: string }>('select count(*)::text as n from ledger.journal');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect((await db.query('select 1 from ledger.journal where idempotency_key = $1', ['bad-1'])).rowCount).toBe(0);
  });

  it('the database trigger alone rejects an unbalanced journal, even bypassing post() (TST-LED-001)', async () => {
    const jid = uuidv7();
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`insert into ledger.journal (id, idempotency_key, kind, effective_at) values ($1, 'raw-bad', 'x', now())`, [jid]);
        await tx.query(`insert into ledger.posting (journal_id, account_id, currency, amount_minor) values ($1, $2, 'USD', 5), ($1, $3, 'USD', -4)`, [jid, acct['wallet:noa'], acct['fee_income']]);
      }),
    ).rejects.toThrow(/UNBALANCED/);
    expect((await db.query('select 1 from ledger.journal where id = $1', [jid])).rowCount).toBe(0);
  });

  it('a journal must balance per currency, not across currencies', async () => {
    await expect(ledger.post({ idempotencyKey: 'xcur', kind: 'fx', postings: [p('wallet:noa', 100n, 'USD'), p('wallet:noa:ils', -100n, 'ILS')] })).rejects.toMatchObject({ code: 'UNBALANCED' });
    const ok = await ledger.post({
      idempotencyKey: 'fx-1',
      kind: 'fx',
      postings: [p('wallet:noa', 100n, 'USD'), p('partner_settlement', -100n, 'USD'), p('wallet:noa:ils', -371n, 'ILS'), p('partner_settlement:ils', 371n, 'ILS')],
      metadata: { fx_markup_bps: 75 },
    });
    expect(ok.postings.length).toBe(4);
  });

  it('the app role cannot UPDATE, DELETE or TRUNCATE ledger rows (TST-LED-002)', async () => {
    await db.asRole('club_app', async (app) => {
      await expect(app.query('update ledger.posting set amount_minor = 1')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('delete from ledger.journal')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('truncate ledger.posting')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('update ledger.account set currency = $1', ['ILS'])).rejects.toMatchObject({ code: '42501' });
      // What it may do: read, insert, and maintain the balance cache.
      expect((await app.query('select count(*) from ledger.journal')).rowCount).toBe(1);
      await expect(app.query('update ledger.account_balance set version = version')).resolves.toBeTruthy();
    });
  });

  it('post() itself works under the app role (it only inserts and maintains the balance cache)', async () => {
    await db.asRole('club_app', async (app) => {
      const scoped = new PostgresLedger({ query: app.query, transaction: db.transaction });
      const j = await scoped.post({ idempotencyKey: 'as-app', kind: 'fee', postings: [p('wallet:noa', 50n), p('fee_income', -50n)] });
      expect(j.id).toBeTruthy();
    });
  });

  it('the same idempotency key returns the original journal, even with different postings (TST-LED-003)', async () => {
    const a = await ledger.post({ idempotencyKey: 'hook-evt-77', kind: 'load', postings: [p('partner_settlement', 2_500n), p('wallet:noa', -2_500n)] });
    const b = await ledger.post({ idempotencyKey: 'hook-evt-77', kind: 'load', postings: [p('partner_settlement', 9_999n), p('wallet:noa', -9_999n)] });
    expect(b.id).toBe(a.id);
    expect(b.postings).toEqual(a.postings);
    expect((await db.query('select 1 from ledger.journal where idempotency_key = $1', ['hook-evt-77'])).rowCount).toBe(1);
  });

  it('concurrent posts with one key produce exactly one journal', async () => {
    const input = { idempotencyKey: 'race-1', kind: 'load', postings: [p('partner_settlement', 1n), p('wallet:dani', -1n)] };
    const results = await Promise.all(Array.from({ length: 5 }, () => ledger.post(input)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it('reverses exactly once and restores balances (invariant 4)', async () => {
    const start = await ledger.balance(acct['wallet:dani']!, 'USD');
    const j = await ledger.post({ idempotencyKey: 'p2p-9', kind: 'p2p', postings: [p('wallet:dani', 700n), p('wallet:noa', -700n)] });
    expect(await ledger.balance(acct['wallet:dani']!, 'USD')).toBe(start + 700n);
    const r = await ledger.reverse(j.id, 'rev-p2p-9');
    expect(r.reversesId).toBe(j.id);
    expect(await ledger.balance(acct['wallet:dani']!, 'USD')).toBe(start);
    await expect(ledger.reverse(j.id, 'rev-p2p-9-again')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await ledger.reverse(j.id, 'rev-p2p-9')).id).toBe(r.id);
  });

  it('validates before touching the database: zero legs, single leg, unknown reversal target', async () => {
    await expect(ledger.post({ idempotencyKey: 'z', kind: 'x', postings: [p('wallet:noa', 0n), p('fee_income', 0n)] })).rejects.toBeInstanceOf(DomainError);
    await expect(ledger.post({ idempotencyKey: 's', kind: 'x', postings: [p('wallet:noa', 1n)] })).rejects.toMatchObject({ code: 'UNBALANCED' });
    await expect(ledger.reverse(uuidv7(), 'r')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('matches the reference ledger on random balanced journals and keeps system totals at zero (invariant 1)', async () => {
    const names = ['wallet:noa', 'wallet:dani', 'partner_settlement', 'fee_income'];
    const balanced = fc
      .array(fc.tuple(fc.constantFrom(...names), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.boolean()), { minLength: 1, maxLength: 4 })
      .map((legs) => {
        const out: Posting[] = legs.map(([n, amt, debit]) => p(n, debit ? amt : -amt));
        const total = out.reduce((s, x) => s + x.amountMinor, 0n);
        if (total !== 0n) out.push(p('partner_settlement', -total));
        return out;
      })
      .filter((legs) => new Set(legs.map((l) => l.accountId)).size === legs.length); // one posting per account per journal (unique constraint)
    const reference = new Ledger();
    const seed = Date.now();
    const deltas = new Map<string, bigint>();
    await fc.assert(
      fc.asyncProperty(fc.array(balanced, { minLength: 1, maxLength: 6 }), async (journals) => {
        for (const postings of journals) {
          const key = `prop-${seed}-${Math.random()}`;
          const a = reference.post({ idempotencyKey: key, kind: 'prop', postings });
          const b = await ledger.post({ idempotencyKey: key, kind: 'prop', postings });
          expect(b.postings.map((x) => x.amountMinor)).toEqual(a.postings.map((x) => x.amountMinor));
          for (const x of postings) deltas.set(x.accountId, (deltas.get(x.accountId) ?? 0n) + x.amountMinor);
        }
      }),
      { numRuns: 15 },
    );
    for (const [c, t] of await ledger.totals()) expect(t, `total for ${c}`).toBe(0n);
    for (const n of names) expect(reference.balance(acct[n]!, 'USD')).toBe(deltas.get(acct[n]!) ?? 0n);
  }, 60_000);

  it('account_balance equals the sum of postings for every account (invariant 2, the nightly proof query)', async () => {
    const breaks = await db.query(
      `select b.account_id from ledger.account_balance b
         join (select account_id, coalesce(sum(amount_minor),0) as s from ledger.posting group by account_id) s using (account_id)
        where b.balance_minor <> s.s`,
    );
    expect(breaks.rows).toEqual([]);
  });
});

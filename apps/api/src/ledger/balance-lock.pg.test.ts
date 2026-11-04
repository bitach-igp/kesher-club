// T-0544 on real Postgres (REQ-WAL-001, REQ-PAY-002, REQ-CRD-003, F13/F36): the race PGlite cannot show, because PGlite is one
// connection. It runs only when TEST_PG_URL names a migrated Postgres 16 (the desktop checker does this, see
// handoff/desktop/T-0544-wallet-lock-race.md); elsewhere it is skipped. Two or more real connections race debits of one wallet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Currency, type Posting } from '@kesher/domain';
import { PostgresLedger } from './post.ts';
import { createPgDatabase, type PgDatabase } from '../pg.ts';

const url = process.env['TEST_PG_URL'];
const run = url ? describe : describe.skip;

run('postNoOverdraft on real Postgres (two or more connections)', () => {
  let db: PgDatabase;
  let ledger: PostgresLedger;
  const mk = async (type: 'wallet' | 'partner_settlement', currency: Currency = 'USD'): Promise<string> => {
    const id = uuidv7();
    await db.query(`insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, $4, $5)`, [id, type === 'wallet' ? uuidv7() : null, type, currency, type === 'wallet' ? 'C' : 'D']);
    return id;
  };
  const p = (accountId: string, amountMinor: bigint, currency: Currency = 'USD'): Posting => ({ accountId, currency, amountMinor });
  const fund = async (wallet: string, partner: string, minor: bigint, tag: string) => {
    await ledger.post({ idempotencyKey: `pg-fund-${tag}`, kind: 'load', postings: [p(partner, minor), p(wallet, -minor)] });
  };

  beforeAll(() => {
    db = createPgDatabase(url!, { max: 20 });
    ledger = new PostgresLedger(db);
  });
  afterAll(async () => db.close());

  it('two simultaneous debits of the whole balance: exactly one succeeds, the other is refused, the wallet ends at zero (never below)', async () => {
    const partner = await mk('partner_settlement');
    const wallet = await mk('wallet');
    const other = await mk('wallet');
    await fund(wallet, partner, 10_000n, `two-${wallet}`);
    const results = await Promise.allSettled([
      ledger.postNoOverdraft({ idempotencyKey: `pg-a-${wallet}`, kind: 'p2p', postings: [p(wallet, 10_000n), p(other, -10_000n)] }),
      ledger.postNoOverdraft({ idempotencyKey: `pg-b-${wallet}`, kind: 'p2p', postings: [p(wallet, 10_000n), p(other, -10_000n)] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await ledger.balance(wallet, 'USD')).toBe(0n);
    expect(await ledger.balance(other, 'USD')).toBe(-10_000n);
  });

  it('thirty simultaneous debits of 1,000 against 10,000: exactly ten succeed and the wallet is exactly empty', async () => {
    const partner = await mk('partner_settlement');
    const wallet = await mk('wallet');
    const other = await mk('wallet');
    await fund(wallet, partner, 10_000n, `many-${wallet}`);
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => ledger.postNoOverdraft({ idempotencyKey: `pg-m${i}-${wallet}`, kind: 'p2p', postings: [p(wallet, 1_000n), p(other, -1_000n)] })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'INSUFFICIENT_FUNDS')).toHaveLength(20);
    expect(await ledger.balance(wallet, 'USD')).toBe(0n);
  });

  it('the same key raced many times posts once and every caller gets that journal (the replay is answered before the check)', async () => {
    const partner = await mk('partner_settlement');
    const wallet = await mk('wallet');
    const other = await mk('wallet');
    await fund(wallet, partner, 5_000n, `same-${wallet}`);
    const key = `pg-same-${wallet}`;
    const out = await Promise.all(Array.from({ length: 8 }, () => ledger.postNoOverdraft({ idempotencyKey: key, kind: 'p2p', postings: [p(wallet, 5_000n), p(other, -5_000n)] })));
    expect(new Set(out.map((j) => j.id)).size).toBe(1);
    expect(await ledger.balance(wallet, 'USD')).toBe(0n);
  });

  it('opposite sends between two wallets at the same time do not deadlock (locks are taken in account order)', async () => {
    const partner = await mk('partner_settlement');
    const x = await mk('wallet');
    const y = await mk('wallet');
    await fund(x, partner, 100_000n, `dl-x-${x}`);
    await fund(y, partner, 100_000n, `dl-y-${y}`);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? ledger.postNoOverdraft({ idempotencyKey: `pg-dl-xy-${i}-${x}`, kind: 'p2p', postings: [p(x, 100n), p(y, -100n)] })
          : ledger.postNoOverdraft({ idempotencyKey: `pg-dl-yx-${i}-${x}`, kind: 'p2p', postings: [p(y, 100n), p(x, -100n)] }),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await ledger.balance(x, 'USD')).toBe(-100_000n);
    expect(await ledger.balance(y, 'USD')).toBe(-100_000n);
  });

  it('a card-authorisation-sized debit posts quickly (serial, not under load: p99 of 200 posts under 100 ms; the 300 ms JIT p99 under concurrent load is still to measure)', async () => {
    const partner = await mk('partner_settlement');
    const wallet = await mk('wallet');
    const other = await mk('wallet');
    await fund(wallet, partner, 1_000_000n, `lat-${wallet}`);
    const times: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      await ledger.postNoOverdraft({ idempotencyKey: `pg-lat-${i}-${wallet}`, kind: 'auth_hold', postings: [p(wallet, 100n), p(other, -100n)] });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.99)]!).toBeLessThan(100);
  });
});

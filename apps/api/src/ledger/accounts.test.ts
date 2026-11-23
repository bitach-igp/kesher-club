// TST-WAL-001: each verified member has USD and ILS purses; available = settled − holds.
// Given a $20 pending auth on $100, available shows $80.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AccountService, AUTHORISATION_SYSTEM_ACCOUNTS, CURRENCIES, ensureAccountRowReport, provisionAuthorisationSystemAccounts, provisionPendingAccounts, SYSTEM_OWNER, type LedgerAccount, type Purse } from './accounts.ts';
import { PostgresLedger } from './post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { Database, QueryResult } from '../db.ts';
import type { Currency } from '@kesher/domain';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
}, 60_000);
afterAll(async () => db.close());

describe('AccountService (REQ-WAL-001)', () => {
  it('provisions a wallet and a pending (holds) account per currency, idempotently', async () => {
    const partyId = uuidv7();
    const first = await accounts.provisionMember(partyId);
    const second = await accounts.provisionMember(partyId);
    expect(first.map((a) => `${a.type}:${a.currency}`).sort()).toEqual(['pending:ILS', 'pending:USD', 'wallet:ILS', 'wallet:USD']);
    expect(second.map((a) => a.id).sort()).toEqual(first.map((a) => a.id).sort());
    expect((await db.query('select count(*)::int as n from ledger.account where owner_party_id = $1', [partyId])).rows[0]).toEqual({ n: 4 });
  });

  it('system accounts (partner settlement, fee income, …) exist once per currency', async () => {
    const a = await accounts.systemAccount('partner_settlement', 'USD');
    const b = await accounts.systemAccount('partner_settlement', 'USD');
    expect(b).toBe(a);
    expect((await db.query('select owner_party_id from ledger.account where id = $1', [a])).rows[0]).toEqual({ owner_party_id: SYSTEM_OWNER });
  });

  it('$100 settled with a $20 pending authorisation shows $80 available (TST-WAL-001)', async () => {
    const partyId = uuidv7();
    await accounts.provisionMember(partyId);
    const wallet = await accounts.memberAccount(partyId, 'wallet', 'USD');
    const pending = await accounts.memberAccount(partyId, 'pending', 'USD');
    const partner = await accounts.systemAccount('partner_settlement', 'USD');
    // Load: partner settlement funds the wallet (wallet is a credit-normal account: −10000 = +$100 for the member).
    await ledger.post({ idempotencyKey: `load:${partyId}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 10_000n }, { accountId: wallet, currency: 'USD', amountMinor: -10_000n }] });
    // JIT hold: $20 moves from wallet to pending until the transaction clears.
    await ledger.post({ idempotencyKey: `hold:${partyId}`, kind: 'auth_hold', postings: [{ accountId: wallet, currency: 'USD', amountMinor: 2_000n }, { accountId: pending, currency: 'USD', amountMinor: -2_000n }] });
    const purses = await accounts.purses(partyId);
    const usd = purses.find((x) => x.currency === 'USD')!;
    expect(usd.settled).toEqual(money(10_000n, 'USD'));
    expect(usd.holds).toEqual(money(2_000n, 'USD'));
    expect(usd.available).toEqual(money(8_000n, 'USD'));
    const ils = purses.find((x) => x.currency === 'ILS')!;
    expect(ils.available).toEqual(money(0n, 'ILS'));
  });

  it('available is never negative unless a stand-in approval happened; such a purse is flagged (invariant 5)', async () => {
    const partyId = uuidv7();
    await accounts.provisionMember(partyId);
    const wallet = await accounts.memberAccount(partyId, 'wallet', 'USD');
    const pending = await accounts.memberAccount(partyId, 'pending', 'USD');
    await ledger.post({ idempotencyKey: `standin:${partyId}`, kind: 'auth_hold', postings: [{ accountId: wallet, currency: 'USD', amountMinor: 500n }, { accountId: pending, currency: 'USD', amountMinor: -500n }], metadata: { standIn: true } });
    const usd = (await accounts.purses(partyId)).find((x) => x.currency === 'USD')!;
    expect(usd.available).toEqual(money(-500n, 'USD'));
    expect(usd.overdrawn).toBe(true);
    expect((await accounts.overdrawnPurses()).map((o) => o.partyId)).toContain(partyId);
  });

  it('the listAccounts shape is the OpenAPI Account schema with Money on the wire', async () => {
    const partyId = uuidv7();
    await accounts.provisionMember(partyId);
    const body = await accounts.listAccountsBody(partyId);
    expect(body.items.length).toBe(2);
    expect(body.items[0]).toMatchObject({ currency: expect.stringMatching(/USD|ILS/), settled: { minor: '0' }, holds: { minor: '0' }, available: { minor: '0' } });
  });
});

// T-0413: the card authorisation reads accounts and never creates one.
describe('provisioning for the card authorisation (T-0413)', () => {
  const count = async (where: string, args: unknown[]) => Number((await db.query<{ n: string }>(`select count(*) as n from ledger.account where ${where}`, args)).rows[0]!.n);

  it('provisionPendingAccounts creates the holds account in both currencies, no wallet, and is safe to repeat', async () => {
    const party = uuidv7();
    await provisionPendingAccounts(db, party);
    await provisionPendingAccounts(db, party);
    expect(await count(`owner_party_id = $1 and type = 'pending'`, [party])).toBe(2);
    expect(await count(`owner_party_id = $1 and type = 'wallet'`, [party])).toBe(0);
  });

  it('provisionAuthorisationSystemAccounts creates fx_position and fee_income in both currencies, once', async () => {
    await provisionAuthorisationSystemAccounts(db);
    await provisionAuthorisationSystemAccounts(db);
    expect(AUTHORISATION_SYSTEM_ACCOUNTS).toEqual(['fx_position', 'fee_income']);
    expect(await count(`owner_party_id = $1 and type in ('fx_position', 'fee_income')`, [SYSTEM_OWNER])).toBe(4);
  });

  it('findMemberAccount and findSystemAccount return what exists and throw NOT_FOUND for what does not, creating nothing', async () => {
    const party = uuidv7();
    const before = await count('true', []);
    await expect(accounts.findMemberAccount(party, 'pending', 'USD')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(accounts.findSystemAccount('suspense', 'USD')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await count('true', [])).toBe(before);
    await provisionPendingAccounts(db, party);
    const found = await accounts.findMemberAccount(party, 'pending', 'USD');
    expect(found).toBe(await accounts.memberAccount(party, 'pending', 'USD'));
    expect(await accounts.findSystemAccount('fx_position', 'ILS')).toBe(await accounts.systemAccount('fx_position', 'ILS'));
  });
});

// T-0779: provisionMember and purses create and read a member's accounts in batches; what they return and leave behind is unchanged.
describe('T-0779: batched account provisioning', () => {
  const LOOP: readonly { type: 'wallet' | 'pending'; currency: Currency }[] = [
    { type: 'wallet', currency: 'USD' },
    { type: 'pending', currency: 'USD' },
    { type: 'wallet', currency: 'ILS' },
    { type: 'pending', currency: 'ILS' },
  ];
  type Row = { id: string; type: string; currency: string; normal_side: string; created_at: string };
  const rowsOf = async (party: string) => (await db.query<Row>(`select id, type::text, currency::text, normal_side, created_at::text from ledger.account where owner_party_id = $1 order by type::text, currency::text`, [party])).rows;
  const OLD = '2020-01-01T00:00:00Z';
  /** Creates the slots in `have` the way the pre-change code did, with a creation time the batch could not mistake for its own. */
  async function seed(party: string, have: number[]): Promise<Map<number, string>> {
    const ids = new Map<number, string>();
    for (const i of have) {
      const slot = LOOP[i]!;
      const r = await ensureAccountRowReport(db, party, slot.type, slot.currency);
      ids.set(i, r.id);
    }
    await db.query(`update ledger.account set created_at = $2::timestamptz where owner_party_id = $1`, [party, OLD]);
    return ids;
  }
  /** A database that counts, and can hook, every statement. */
  function watched(hook?: (text: string, result: QueryResult<never>) => Promise<QueryResult<never>> | QueryResult<never>) {
    const log: string[] = [];
    const wrapped: Database = {
      query: (async (text: string, params?: readonly unknown[]) => {
        log.push(text);
        const r = await db.query(text, params);
        return hook ? hook(text, r as QueryResult<never>) : r;
      }) as Database['query'],
      transaction: (fn) => db.transaction(fn),
    };
    return { db: wrapped, log, service: new AccountService(wrapped, new PostgresLedger(wrapped)) };
  }
  const fund = async (party: string, currency: Currency, type: 'wallet' | 'pending', credit: bigint, key: string) => {
    const account = await accounts.memberAccount(party, type, currency);
    const partner = await accounts.systemAccount('partner_settlement', currency);
    await ledger.post({ idempotencyKey: key, kind: 'load', postings: [{ accountId: partner, currency, amountMinor: credit }, { accountId: account, currency, amountMinor: -credit }] });
  };

  // ---- characterization: green before and after ----

  it('provisionMember returns the four accounts in currency order, wallet before pending, with the owner, and creates credit-normal rows', async () => {
    const party = uuidv7();
    const out = await accounts.provisionMember(party);
    expect(out.map((a) => [a.type, a.currency, a.ownerPartyId])).toEqual(LOOP.map((s) => [s.type, s.currency, party]));
    const rows = await rowsOf(party);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.normal_side === 'C')).toBe(true);
    for (const a of out) expect(rows.find((r) => r.id === a.id && r.type === a.type && r.currency === a.currency)).toBeDefined();
    expect(new Set(out.map((a) => a.id)).size).toBe(4);
    // Another owner's accounts are untouched, and nothing was journaled.
    expect(await rowsOf(uuidv7())).toEqual([]);
  });

  it('every partially provisioned member (all 16 subsets) is completed in the same order without touching the rows that exist', async () => {
    for (let mask = 0; mask < 16; mask++) {
      const party = uuidv7();
      const have = LOOP.map((_, i) => i).filter((i) => (mask >> i) & 1);
      const existing = await seed(party, have);
      const out = await accounts.provisionMember(party);
      expect(out.map((a) => [a.type, a.currency])).toEqual(LOOP.map((s) => [s.type, s.currency]));
      for (const [i, id] of existing) expect(out[i]!.id).toBe(id);
      const rows = await rowsOf(party);
      expect(rows).toHaveLength(4);
      for (const [i, a] of out.entries()) {
        const row = rows.find((r) => r.id === a.id)!;
        expect([row.type, row.currency, row.normal_side]).toEqual([LOOP[i]!.type, LOOP[i]!.currency, 'C']);
        // Existing rows keep their creation time; only the missing ones are new.
        expect(row.created_at.startsWith('2020-01-01')).toBe(existing.has(i));
      }
      // The missing rows are inserted in loop order (every batch walks the accounts the same way, so concurrent batches cannot deadlock).
      const physical = (await db.query<{ type: string; currency: string; created_at: string }>(`select type::text, currency::text, created_at::text from ledger.account where owner_party_id = $1 order by ctid`, [party])).rows.filter((r) => !r.created_at.startsWith('2020-01-01'));
      expect(physical.map((r) => `${r.type}:${r.currency}`)).toEqual(LOOP.filter((_, i) => !existing.has(i)).map((s) => `${s.type}:${s.currency}`));
      expect((await accounts.provisionMember(party)).map((a) => a.id)).toEqual(out.map((a) => a.id));
      expect(await rowsOf(party)).toEqual(rows);
    }
  });

  it('two concurrent provisionMember calls for one party end with four rows and equal results', async () => {
    for (let k = 0; k < 5; k++) {
      const party = uuidv7();
      const [a, b, c] = await Promise.all([accounts.provisionMember(party), accounts.provisionMember(party), accounts.provisionMember(party)]);
      expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id));
      expect(c.map((x) => x.id)).toEqual(a.map((x) => x.id));
      expect(await rowsOf(party)).toHaveLength(4);
    }
  });

  it('a competitor that creates an account while provisioning is under way is converged on: four rows, results equal the rows', async () => {
    for (let i = 0; i < LOOP.length; i++) {
      const party = uuidv7();
      let fired = false;
      const w = watched(async (text, r) => {
        if (!fired && /ledger\.account/.test(text)) {
          fired = true;
          await db.query(`insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, $4, 'C') on conflict do nothing`, [uuidv7(), party, LOOP[i]!.type, LOOP[i]!.currency]);
        }
        return r;
      });
      const out = await w.service.provisionMember(party);
      expect(fired).toBe(true);
      const rows = await rowsOf(party);
      expect(rows).toHaveLength(4);
      expect(out.map((a) => a.id)).toEqual(LOOP.map((s) => rows.find((r) => r.type === s.type && r.currency === s.currency)!.id));
      expect((await w.service.provisionMember(party)).map((a) => a.id)).toEqual(out.map((a) => a.id));
    }
  });

  it('purses: USD then ILS, the wallet is the purse id, balances negate the ledger, holds come from pending, overdrawn flags a negative wallet', async () => {
    const party = uuidv7();
    await accounts.provisionMember(party);
    await fund(party, 'USD', 'wallet', 10_000n, `t0779-a-${party}`);
    await fund(party, 'USD', 'pending', 1_500n, `t0779-b-${party}`);
    await fund(party, 'ILS', 'wallet', -700n, `t0779-c-${party}`); // wallet debited past zero
    await fund(party, 'ILS', 'pending', 40n, `t0779-d-${party}`);
    const purses = await accounts.purses(party);
    const rows = await rowsOf(party);
    const wallet = (c: string) => rows.find((r) => r.type === 'wallet' && r.currency === c)!.id;
    expect(purses).toEqual([
      { id: wallet('USD'), currency: 'USD', settled: money(11_500n, 'USD'), holds: money(1_500n, 'USD'), available: money(10_000n, 'USD'), overdrawn: false },
      { id: wallet('ILS'), currency: 'ILS', settled: money(-660n, 'ILS'), holds: money(40n, 'ILS'), available: money(-700n, 'ILS'), overdrawn: true },
    ]);
  });

  it('purses on a member with no accounts creates all four; with some, only the missing ones; the result is the same either way', async () => {
    const fresh = uuidv7();
    const p1 = await accounts.purses(fresh);
    expect(await rowsOf(fresh)).toHaveLength(4);
    expect(p1.map((p) => [p.currency, p.settled.minor, p.holds.minor, p.available.minor, p.overdrawn])).toEqual([['USD', 0n, 0n, 0n, false], ['ILS', 0n, 0n, 0n, false]]);
    expect((await accounts.purses(fresh)).map((p) => p.id)).toEqual(p1.map((p) => p.id));
    for (let mask = 0; mask < 16; mask++) {
      const party = uuidv7();
      const existing = await seed(party, LOOP.map((_, i) => i).filter((i) => (mask >> i) & 1));
      const purses = await accounts.purses(party);
      const rows = await rowsOf(party);
      expect(rows).toHaveLength(4);
      expect(purses.map((p) => p.id)).toEqual([rows.find((r) => r.type === 'wallet' && r.currency === 'USD')!.id, rows.find((r) => r.type === 'wallet' && r.currency === 'ILS')!.id]);
      for (const [i, id] of existing) expect(rows.find((r) => r.id === id)!.type + rows.find((r) => r.id === id)!.currency).toBe(LOOP[i]!.type + LOOP[i]!.currency);
    }
  });

  it('purses on existing accounts needs no right to insert; with accounts missing, the refusal reaches the caller', async () => {
    const party = uuidv7();
    await accounts.provisionMember(party);
    const missing = uuidv7();
    await db.query(`grant select on ledger.account, ops.account_balance to club_jit`);
    const read = await db.asRole('club_jit', async (base) => {
      const roleDb: Database = { query: base.query, transaction: (fn) => db.transaction(fn) };
      const svc = new AccountService(roleDb, new PostgresLedger(roleDb));
      return { ok: await svc.purses(party), refused: await svc.purses(missing).then(() => 'created', (e: { code?: string }) => e.code) };
    });
    expect(read.ok.map((p) => p.currency)).toEqual(['USD', 'ILS']);
    expect(read.refused).toBe('42501');
    expect(await rowsOf(missing)).toEqual([]);
  });

  // ---- statement counts: red before the change ----

  it('provisionMember issues one statement for a fresh member, a partially provisioned one and a complete one', async () => {
    const w = watched();
    await w.service.provisionMember(uuidv7());
    expect(w.log).toHaveLength(1);
    const partial = uuidv7();
    await seed(partial, [0]);
    w.log.length = 0;
    await w.service.provisionMember(partial);
    expect(w.log).toHaveLength(1);
    w.log.length = 0;
    await w.service.provisionMember(partial);
    expect(w.log).toHaveLength(1);
  });

  it('purses issues one read for the accounts when they exist (plus the four balance reads), and one more statement to create what is missing', async () => {
    const w = watched();
    const party = uuidv7();
    await accounts.provisionMember(party);
    await w.service.purses(party);
    expect(w.log).toHaveLength(1 + 4);
    w.log.length = 0;
    await w.service.purses(uuidv7());
    expect(w.log).toHaveLength(2 + 4);
  });

  it('a creator whose result misses a slot (a competitor committed after the statement began) reads the slots again and still returns all four', async () => {
    const party = uuidv7();
    let hidden = false;
    const w = watched(async (text, r) => {
      if (!hidden && /with want/.test(text)) {
        hidden = true;
        return { ...r, rows: (r.rows as { ord: number }[]).filter((x) => x.ord !== 2), rowCount: r.rowCount - 1 } as never;
      }
      return r;
    });
    const out = await w.service.provisionMember(party);
    expect(hidden).toBe(true);
    expect(w.log).toHaveLength(2);
    expect(w.log[1]).not.toMatch(/insert/i); // the second statement only reads
    const rows = await rowsOf(party);
    expect(out.map((a) => a.id)).toEqual(LOOP.map((s) => rows.find((r) => r.type === s.type && r.currency === s.currency)!.id));
  });

  it('when both balance reads of a currency fail, the wallet read\'s error surfaces, as when they ran one after the other', async () => {
    const party = uuidv7();
    await accounts.provisionMember(party);
    const rows = await rowsOf(party);
    const idOf = (type: string, currency: string) => rows.find((r) => r.type === type && r.currency === currency)!.id;
    const l = new PostgresLedger(db);
    vi.spyOn(l, 'balance').mockImplementation(async (id: string) => {
      if (id === idOf('wallet', 'USD')) {
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('wallet read failed');
      }
      if (id === idOf('pending', 'USD')) throw new Error('pending read failed');
      return 0n;
    });
    await expect(new AccountService(db, l).purses(party)).rejects.toThrow('wallet read failed');
    vi.restoreAllMocks();
  });

  // ---- differential: against the pre-change loops, over random scenarios ----

  const legacyProvision = async (party: string): Promise<LedgerAccount[]> => {
    const out: LedgerAccount[] = [];
    for (const currency of CURRENCIES) {
      for (const type of ['wallet', 'pending'] as const) out.push({ id: (await ensureAccountRowReport(db, party, type, currency)).id, ownerPartyId: party, type, currency });
    }
    return out;
  };
  const legacyPurses = async (party: string): Promise<Purse[]> => {
    const out: Purse[] = [];
    for (const currency of CURRENCIES) {
      const wallet = (await ensureAccountRowReport(db, party, 'wallet', currency)).id;
      const pending = (await ensureAccountRowReport(db, party, 'pending', currency)).id;
      const available = -(await ledger.balance(wallet, currency));
      const holds = -(await ledger.balance(pending, currency));
      out.push({ id: wallet, currency, settled: money(available + holds, currency), holds: money(holds, currency), available: money(available, currency), overdrawn: available < 0n });
    }
    return out;
  };

  it('matches the pre-change provisionMember and purses over random partial states and balances (rows, results, balances)', { timeout: 120_000 }, async () => {
    let seedValue = 0x779;
    const rnd = (n: number) => {
      seedValue = (seedValue + 0x6d2b79f5) >>> 0;
      let t = seedValue;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    type Step = { mask: number; funds: bigint[]; first: 'provision' | 'purses' };
    const steps: Step[] = Array.from({ length: 40 }, (_, k) => ({ mask: k < 16 ? k : rnd(16), funds: LOOP.map(() => (rnd(3) === 0 ? 0n : BigInt(rnd(20_001) - 5_000))), first: rnd(2) === 0 ? 'provision' : 'purses' }));
    const run = async (party: string, step: Step, impl: 'new' | 'legacy') => {
      const existing = await seed(party, LOOP.map((_, i) => i).filter((i) => (step.mask >> i) & 1));
      let n = 0;
      for (const [i, amount] of step.funds.entries()) {
        if (amount === 0n || !existing.has(i)) continue;
        const slot = LOOP[i]!;
        const partner = await accounts.systemAccount('partner_settlement', slot.currency);
        await ledger.post({ idempotencyKey: `t0779-${party}-${n++}`, kind: 'load', postings: [{ accountId: partner, currency: slot.currency, amountMinor: amount }, { accountId: existing.get(i)!, currency: slot.currency, amountMinor: -amount }] });
      }
      const provisioned = impl === 'new' ? () => accounts.provisionMember(party) : () => legacyProvision(party);
      const pursed = impl === 'new' ? () => accounts.purses(party) : () => legacyPurses(party);
      const results = step.first === 'provision' ? [await provisioned(), await pursed(), await provisioned()] : [await pursed(), await provisioned(), await pursed()];
      const rows = await rowsOf(party);
      const balances = (await db.query(`select a.type::text, a.currency::text, b.balance_minor::text from ops.account_balance b join ledger.account a on a.id = b.account_id where a.owner_party_id = $1 order by 1, 2`, [party])).rows;
      const postings = (await db.query(`select a.type::text, a.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where a.owner_party_id = $1 order by p.id`, [party])).rows;
      const label = new Map(rows.map((r) => [r.id, `${r.type}:${r.currency}`]));
      label.set(party, 'P');
      let json = JSON.stringify({ results, rows: rows.map((r) => ({ type: r.type, currency: r.currency, side: r.normal_side, old: r.created_at.startsWith('2020-01-01') })), balances, postings }, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
      for (const [from, to] of label) json = json.split(from).join(to);
      return { json, kept: [...existing].every(([i, id]) => rows.find((r) => r.id === id)!.type === LOOP[i]!.type) };
    };
    for (const [k, step] of steps.entries()) {
      const a = await run(uuidv7(), step, 'new');
      const b = await run(uuidv7(), step, 'legacy');
      expect(a.kept).toBe(true);
      expect(a.json, JSON.stringify({ k, ...step, funds: step.funds.map(String) })).toEqual(b.json);
    }
  });
});

// TST-WAL-001: each verified member has USD and ILS purses; available = settled − holds.
// Given a $20 pending auth on $100, available shows $80.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AccountService, AUTHORISATION_SYSTEM_ACCOUNTS, provisionAuthorisationSystemAccounts, provisionPendingAccounts, SYSTEM_OWNER } from './accounts.ts';
import { PostgresLedger } from './post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

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

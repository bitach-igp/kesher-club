// Account provisioning (T-0202, REQ-WAL-001): every verified member gets a wallet and a pending
// (holds) account in USD and ILS. Balances are read from the cache post() maintains.
//   settled   = wallet + pending  (what the member owns, including money reserved by holds)
//   holds     = pending           (reserved by JIT authorisations not yet cleared)
//   available = wallet            (what the next authorisation can use)
// Wallet and pending are credit-normal: a negative ledger balance is money the member has.
import { DomainError, money, toWire, type Currency, type Money } from '@kesher/domain';
import { uuidv7 } from '@kesher/domain';
import { isPgError, PG, type Database } from '../db.ts';
import type { PostgresLedger } from './post.ts';

export type AccountType = 'wallet' | 'pending' | 'institution_master' | 'partner_settlement' | 'fx_position' | 'fee_income' | 'interchange_income' | 'addon_payable' | 'suspense' | 'payout_reserve';
export const CURRENCIES: readonly Currency[] = ['USD', 'ILS'];
/** Owner of system accounts (no party). */
export const SYSTEM_OWNER = '00000000-0000-7000-8000-000000000000';

const CREDIT_NORMAL = new Set<AccountType>(['wallet', 'pending', 'institution_master', 'addon_payable', 'payout_reserve']);
const normalSide = (type: AccountType): 'C' | 'D' => (CREDIT_NORMAL.has(type) ? 'C' : 'D');

interface Slot {
  type: AccountType;
  currency: Currency;
}
/** A member's four accounts in the order provisioning has always walked them: each currency, wallet before pending. */
const MEMBER_SLOTS: readonly Slot[] = CURRENCIES.flatMap((currency) => (['wallet', 'pending'] as const).map((type): Slot => ({ type, currency })));

/**
 * Inserts the account unless it exists and says whether this call inserted it; concurrent callers converge on one row and exactly one
 * of them sees `created`. Free-standing so the places that provision accounts (card issue, the bootstrap, test and demo setup) need no
 * service wiring.
 */
export async function ensureAccountRowReport(db: Database, ownerPartyId: string, type: AccountType, currency: Currency): Promise<{ id: string; created: boolean }> {
  const found = await db.query<{ id: string }>('select id from ledger.account where owner_party_id = $1 and type = $2 and currency = $3', [ownerPartyId, type, currency]);
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const id = uuidv7();
  try {
    await db.query('insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, $4, $5)', [id, ownerPartyId, type, currency, normalSide(type)]);
    return { id, created: true };
  } catch (e) {
    if (isPgError(e, PG.UNIQUE_VIOLATION)) return { ...(await ensureAccountRowReport(db, ownerPartyId, type, currency)), created: false };
    throw e;
  }
}

/** The ids of the owner's accounts for these slots, in slot order, `undefined` where one does not exist. One read; it writes nothing. */
async function findAccountRows(db: Database, ownerPartyId: string, slots: readonly Slot[]): Promise<(string | undefined)[]> {
  const rows = slots.map((_, i) => `($${i * 3 + 2}::int, $${i * 3 + 3}::ledger.account_type, $${i * 3 + 4}::ledger.currency)`).join(', ');
  const r = await db.query<{ ord: number; id: string }>(
    `select w.ord, a.id from (values ${rows}) as w(ord, type, currency)
       join ledger.account a on a.owner_party_id = $1::uuid and a.type = w.type and a.currency = w.currency`,
    [ownerPartyId, ...slots.flatMap((s, i) => [i, s.type, s.currency])],
  );
  const byOrd = new Map(r.rows.map((x) => [x.ord, x.id]));
  return slots.map((_, i) => byOrd.get(i));
}

/**
 * The owner's accounts for these slots, in slot order, creating the missing ones, in one statement: the whole set is inserted in slot
 * order with `on conflict do nothing` (rows that exist are left untouched), and the result is read back from what was inserted and what
 * was there. A concurrent creator's row can be invisible to that statement (it commits after the statement's snapshot but before our
 * insert is decided), so a slot left without an id is read again; ledger rows are never deleted, so it is there by then. Every caller
 * walks the slots in the same order, so concurrent batches never wait on each other in a cycle.
 */
async function ensureAccountRows(db: Database, ownerPartyId: string, slots: readonly Slot[]): Promise<string[]> {
  const fresh = slots.map(() => uuidv7());
  const rows = slots.map((_, i) => `($${i * 5 + 2}::int, $${i * 5 + 3}::ledger.account_type, $${i * 5 + 4}::ledger.currency, $${i * 5 + 5}::uuid, $${i * 5 + 6}::char(1))`).join(', ');
  const params = [ownerPartyId, ...slots.flatMap((s, i) => [i, s.type, s.currency, fresh[i]!, normalSide(s.type)])];
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await db.query<{ ord: number; id: string | null }>(
      `with want (ord, type, currency, id, side) as (values ${rows}),
            ins as (
              insert into ledger.account (id, owner_party_id, type, currency, normal_side)
              select w.id, $1::uuid, w.type, w.currency, w.side from want w order by w.ord
              on conflict (owner_party_id, type, currency) do nothing
              returning id, type, currency
            )
       select w.ord, coalesce(i.id, a.id) as id
         from want w
         left join ins i on i.type = w.type and i.currency = w.currency
         left join ledger.account a on a.owner_party_id = $1::uuid and a.type = w.type and a.currency = w.currency`,
      params,
    );
    const byOrd = new Map(r.rows.map((x) => [x.ord, x.id]));
    let ids = slots.map((_, i) => byOrd.get(i) ?? undefined);
    if (ids.some((id) => id === undefined)) ids = await findAccountRows(db, ownerPartyId, slots);
    if (ids.every((id) => id !== undefined)) return ids as string[];
  }
  throw new Error('ledger accounts could not be provisioned');
}

async function ensureAccountRow(db: Database, ownerPartyId: string, type: AccountType, currency: Currency): Promise<string> {
  return (await ensureAccountRowReport(db, ownerPartyId, type, currency)).id;
}

/**
 * The member's `pending` (holds) account in every currency, provisioned when a card is issued (T-0413). A card authorisation only
 * reads accounts: its database role may not insert into `ledger.account`. Wallets are not touched; they are created at first use.
 */
export async function provisionPendingAccounts(db: Database, partyId: string): Promise<void> {
  for (const currency of CURRENCIES) await ensureAccountRow(db, partyId, 'pending', currency);
}

/** The system accounts a converted card authorisation posts to, in every currency (T-0413); the demo seed calls this. The production bootstrap (T-0046) uses `ensureAccountRowReport` so it can say which accounts it created. */
export const AUTHORISATION_SYSTEM_ACCOUNTS = ['fx_position', 'fee_income'] as const;
export async function provisionAuthorisationSystemAccounts(db: Database): Promise<void> {
  for (const type of AUTHORISATION_SYSTEM_ACCOUNTS) for (const currency of CURRENCIES) await ensureAccountRow(db, SYSTEM_OWNER, type, currency);
}

export interface LedgerAccount {
  id: string;
  ownerPartyId: string;
  type: AccountType;
  currency: Currency;
}

export interface Purse {
  id: string;
  currency: Currency;
  settled: Money;
  holds: Money;
  available: Money;
  /** True when available < 0 (stand-in approval); surfaced to ops and suspense (invariant 5). */
  overdrawn: boolean;
}

export class AccountService {
  private readonly db: Database;
  private readonly ledger: PostgresLedger;
  constructor(
    db: Database,
    ledger: PostgresLedger,
  ) {
    this.db = db;
    this.ledger = ledger;
  }

  /** Creates wallet + pending in every currency; safe to call again (unique constraint). */
  async provisionMember(partyId: string): Promise<LedgerAccount[]> {
    const ids = await ensureAccountRows(this.db, partyId, MEMBER_SLOTS);
    return MEMBER_SLOTS.map((s, i): LedgerAccount => ({ id: ids[i]!, ownerPartyId: partyId, type: s.type, currency: s.currency }));
  }

  async memberAccount(partyId: string, type: 'wallet' | 'pending', currency: Currency): Promise<string> {
    return (await this.ensure(partyId, type, currency)).id;
  }

  async systemAccount(type: Exclude<AccountType, 'wallet' | 'pending'>, currency: Currency): Promise<string> {
    return (await this.ensure(SYSTEM_OWNER, type, currency)).id;
  }

  /**
   * The institution's own account (T-0613): `institution_master`, owned by the institution's id, one per
   * currency. Fees credit it, allowances and payouts debit it, so its balance is the institution's money,
   * kept by the ledger's own invariants rather than read off journal tags.
   */
  async institutionAccount(institutionId: string, currency: Currency): Promise<string> {
    return (await this.ensure(institutionId, 'institution_master', currency)).id;
  }

  /**
   * The institution's held money (T-0617): an ACH pull waits here, a `pending` account owned by the institution,
   * until the bank's hold date. It is not the institution's to spend: payouts and allowance runs read
   * `institution_master` only, so held money is never their headroom.
   */
  async institutionHoldAccount(institutionId: string, currency: Currency): Promise<string> {
    return (await this.ensure(institutionId, 'pending', currency)).id;
  }

  /**
   * The institution's payout reserve (T-0555): money set aside for a payout waiting on its approver, a `payout_reserve` account owned by
   * the institution. It is still the institution's own money (statements, exports and the dashboard count it), but not available:
   * `institutionBalance` is the master only, so payouts' funds check, allowances and credit headroom never count it.
   */
  async institutionPayoutReserveAccount(institutionId: string, currency: Currency): Promise<string> {
    return (await this.ensure(institutionId, 'payout_reserve', currency)).id;
  }

  /** What the institution has reserved for waiting payouts in a currency (credit-normal, negated). */
  async institutionReserved(institutionId: string, currency: Currency): Promise<Money> {
    return money(-(await this.ledger.balance(await this.institutionPayoutReserveAccount(institutionId, currency), currency)), currency);
  }

  /** What the institution has on hold in a currency (credit-normal, negated). */
  async institutionHolds(institutionId: string, currency: Currency): Promise<Money> {
    return money(-(await this.ledger.balance(await this.institutionHoldAccount(institutionId, currency), currency)), currency);
  }

  /** What the institution holds in a currency: credit-normal, so the ledger balance negated. Below zero, it owes. */
  async institutionBalance(institutionId: string, currency: Currency): Promise<Money> {
    return money(-(await this.ledger.balance(await this.institutionAccount(institutionId, currency), currency)), currency);
  }

  async purses(partyId: string): Promise<Purse[]> {
    // Read first and write only what is missing: a purse read needs no right to insert once the accounts exist.
    let found = await findAccountRows(this.db, partyId, MEMBER_SLOTS);
    if (found.some((id) => id === undefined)) found = await ensureAccountRows(this.db, partyId, MEMBER_SLOTS);
    const out: Purse[] = [];
    for (const [i, currency] of CURRENCIES.entries()) {
      const wallet = found[i * 2]!;
      const pending = found[i * 2 + 1]!;
      // Credit-normal: negate ledger balances to show what the member owns.
      // Both reads start together; if both fail, the wallet's error surfaces, as when they ran one after the other.
      const [walletRead, pendingRead] = await Promise.allSettled([this.ledger.balance(wallet, currency), this.ledger.balance(pending, currency)]);
      if (walletRead.status === 'rejected') throw walletRead.reason;
      if (pendingRead.status === 'rejected') throw pendingRead.reason;
      const available = -walletRead.value;
      const holds = -pendingRead.value;
      out.push({ id: wallet, currency, settled: money(available + holds, currency), holds: money(holds, currency), available: money(available, currency), overdrawn: available < 0n });
    }
    return out;
  }

  /** The OpenAPI `listAccounts` response. */
  async listAccountsBody(partyId: string): Promise<{ items: { id: string; currency: Currency; settled: ReturnType<typeof toWire>; holds: ReturnType<typeof toWire>; available: ReturnType<typeof toWire> }[] }> {
    const purses = await this.purses(partyId);
    return { items: purses.map((p) => ({ id: p.id, currency: p.currency, settled: toWire(p.settled), holds: toWire(p.holds), available: toWire(p.available) })) };
  }

  /** Wallets whose available balance went negative (stand-in approvals); the recon job routes them to suspense cases. */
  async overdrawnPurses(): Promise<{ partyId: string; accountId: string; currency: Currency; available: Money }[]> {
    const r = await this.db.query<{ owner_party_id: string; id: string; currency: Currency; balance_minor: string }>(
      `select a.owner_party_id, a.id, a.currency, b.balance_minor::text as balance_minor
         from ledger.account a join ops.account_balance b on b.account_id = a.id
        where a.type = 'wallet' and b.balance_minor > 0`,
    );
    return r.rows.map((x) => ({ partyId: x.owner_party_id, accountId: x.id, currency: x.currency, available: money(-BigInt(x.balance_minor), x.currency) }));
  }

  private async ensure(ownerPartyId: string, type: AccountType, currency: Currency): Promise<LedgerAccount> {
    return { id: await ensureAccountRow(this.db, ownerPartyId, type, currency), ownerPartyId, type, currency };
  }

  /** Read-only: the member's account, or NOT_FOUND. The card authorisation path uses these and never creates an account (T-0413). */
  async findMemberAccount(partyId: string, type: 'wallet' | 'pending', currency: Currency): Promise<string> {
    return this.find(partyId, type, currency);
  }

  async findSystemAccount(type: Exclude<AccountType, 'wallet' | 'pending'>, currency: Currency): Promise<string> {
    return this.find(SYSTEM_OWNER, type, currency);
  }

  private async find(ownerPartyId: string, type: AccountType, currency: Currency): Promise<string> {
    const r = await this.db.query<{ id: string }>('select id from ledger.account where owner_party_id = $1 and type = $2 and currency = $3', [ownerPartyId, type, currency]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', `No ${type} account in ${currency}`);
    return r.rows[0].id;
  }
}

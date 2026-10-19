// Account provisioning (T-0202, REQ-WAL-001): every verified member gets a wallet and a pending
// (holds) account in USD and ILS. Balances are read from the cache post() maintains.
//   settled   = wallet + pending  (what the member owns, including money reserved by holds)
//   holds     = pending           (reserved by JIT authorisations not yet cleared)
//   available = wallet            (what the next authorisation can use)
// Wallet and pending are credit-normal: a negative ledger balance is money the member has.
import { money, toWire, type Currency, type Money } from '@kesher/domain';
import { uuidv7 } from '@kesher/domain';
import { isPgError, PG, type Database } from '../db.ts';
import type { PostgresLedger } from './post.ts';

export type AccountType = 'wallet' | 'pending' | 'institution_master' | 'partner_settlement' | 'fx_position' | 'fee_income' | 'interchange_income' | 'addon_payable' | 'suspense';
export const CURRENCIES: readonly Currency[] = ['USD', 'ILS'];
/** Owner of system accounts (no party). */
export const SYSTEM_OWNER = '00000000-0000-7000-8000-000000000000';

const CREDIT_NORMAL = new Set<AccountType>(['wallet', 'pending', 'institution_master', 'addon_payable']);

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
    const out: LedgerAccount[] = [];
    for (const currency of CURRENCIES) {
      for (const type of ['wallet', 'pending'] as const) out.push(await this.ensure(partyId, type, currency));
    }
    return out;
  }

  async memberAccount(partyId: string, type: 'wallet' | 'pending', currency: Currency): Promise<string> {
    return (await this.ensure(partyId, type, currency)).id;
  }

  async systemAccount(type: Exclude<AccountType, 'wallet' | 'pending'>, currency: Currency): Promise<string> {
    return (await this.ensure(SYSTEM_OWNER, type, currency)).id;
  }

  async purses(partyId: string): Promise<Purse[]> {
    const out: Purse[] = [];
    for (const currency of CURRENCIES) {
      const wallet = await this.ensure(partyId, 'wallet', currency);
      const pending = await this.ensure(partyId, 'pending', currency);
      // Credit-normal: negate ledger balances to show what the member owns.
      const available = -(await this.ledger.balance(wallet.id, currency));
      const holds = -(await this.ledger.balance(pending.id, currency));
      out.push({ id: wallet.id, currency, settled: money(available + holds, currency), holds: money(holds, currency), available: money(available, currency), overdrawn: available < 0n });
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
    const found = await this.db.query<{ id: string }>('select id from ledger.account where owner_party_id = $1 and type = $2 and currency = $3', [ownerPartyId, type, currency]);
    if (found.rows[0]) return { id: found.rows[0].id, ownerPartyId, type, currency };
    const id = uuidv7();
    try {
      await this.db.query('insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, $4, $5)', [id, ownerPartyId, type, currency, CREDIT_NORMAL.has(type) ? 'C' : 'D']);
      return { id, ownerPartyId, type, currency };
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return this.ensure(ownerPartyId, type, currency);
      throw e;
    }
  }
}

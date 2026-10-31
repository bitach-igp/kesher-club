// The funder's household (T-0534, REQ-WAL-007, P05): each member the caller pays for, from an active, past-due or
// paused membership they fund, with the member's available balance in each purse and their last card spend, and each
// open invite they sent. The household's id is the funder's own party id, and only its funder reads it: any other id
// answers 404 alike (THR-09), so a household's existence is never confirmed to someone else. What the funder may see
// follows the funder privacy notice: balances and spend, never P2P notes or concierge cases. Past-due shows the
// balance like any other: dunning never freezes money already loaded.
//
// One member's activity (T-0537, REQ-WAL-009, P06): for a member the caller funds, their recent transactions across
// both purses (T-0536's rows, which carry no names or notes, so a P2P reads as a P2P and nothing more), this month's
// card spend by category in each currency, and their cards with the controls the funder set, so P09 can open one.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { FunderInvites } from '../billing/funder-invites.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { DisplayNameService } from '../me/display-name.ts';
import type { CardService, CardView } from '../cards/service.ts';
import type { Transaction, TransactionService } from './transactions.ts';

export const WALLET_FLAG = 'wallet.enabled';

export interface HouseholdMember {
  partyId: string;
  displayName: string;
  membershipStatus: 'active' | 'past_due' | 'paused';
  membershipId: string;
  planCode: string;
  balances: ReturnType<typeof toWire>[];
  /** The member's latest card spend: what left the purse, when, and the merchant's category and country. */
  lastSpend?: { amount: ReturnType<typeof toWire>; at: string; mcc?: string; country?: string };
}

export interface Household {
  id: string;
  funderId: string;
  members: HouseholdMember[];
  /** Invites still open, shown as invited until the member accepts. */
  invites: { inviteId: string; memberName: string; membershipStatus: 'invited'; planCode: string; expiresAt: string }[];
}

/** A merchant category code in the words P06 shows; anything else is "other". */
export type SpendCategory = 'food_drink' | 'groceries' | 'transport' | 'shopping' | 'travel' | 'entertainment' | 'other';
const MCC_RANGES: [number, number, SpendCategory][] = [
  [5811, 5814, 'food_drink'],
  [5411, 5411, 'groceries'],
  [5422, 5499, 'groceries'],
  [4111, 4131, 'transport'],
  [4784, 4789, 'transport'],
  [5541, 5542, 'transport'],
  [3000, 3999, 'travel'],
  [4411, 4411, 'travel'],
  [4511, 4511, 'travel'],
  [4722, 4722, 'travel'],
  [7011, 7011, 'travel'],
  [7832, 7832, 'entertainment'],
  [7922, 7922, 'entertainment'],
  [7991, 7999, 'entertainment'],
  [5300, 5399, 'shopping'],
  [5600, 5699, 'shopping'],
  [5700, 5799, 'shopping'],
  [5900, 5999, 'shopping'],
];
export function categoryOf(mcc: string | undefined): SpendCategory {
  const n = Number(mcc);
  return MCC_RANGES.find(([from, to]) => n >= from && n <= to)?.[2] ?? 'other';
}

export interface MemberActivity {
  partyId: string;
  displayName: string;
  /** The latest 50 across both purses, newest first. */
  transactions: Transaction[];
  /** This calendar month's card spend (UTC), held or cleared but not released, per category and currency. */
  spendByCategory: { category: SpendCategory; amount: ReturnType<typeof toWire> }[];
  cards: Pick<CardView, 'id' | 'type' | 'status' | 'last4' | 'lockedByFunder'>[];
}

export interface HouseholdDeps {
  db: Database;
  accounts: Pick<AccountService, 'purses'>;
  displayNames: Pick<DisplayNameService, 'get'>;
  invites: Pick<FunderInvites, 'list'>;
  flags: FeatureFlags;
  transactions: Pick<TransactionService, 'forAccount'>;
  cards: Pick<CardService, 'forParty'>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HouseholdService {
  private readonly d: HouseholdDeps;
  constructor(d: HouseholdDeps) {
    this.d = d;
  }

  async get(householdId: string, callerPartyId: string, now: Date): Promise<Household> {
    // Only the funder's own household; every other id reads as not there.
    await this.requireOwn(householdId, callerPartyId);
    const memberships = await this.d.db.query<{ id: string; member_party_id: string; status: HouseholdMember['membershipStatus']; plan_code: string }>(
      `select distinct on (member_party_id) id, member_party_id, status, plan_code from billing.membership
        where funder_party_id = $1 and status in ('active', 'past_due', 'paused') order by member_party_id, created_at desc`,
      [callerPartyId],
    );
    const members: HouseholdMember[] = [];
    for (const m of memberships.rows) {
      const [name, purses, lastSpend] = await Promise.all([this.d.displayNames.get(m.member_party_id), this.d.accounts.purses(m.member_party_id), this.lastSpend(m.member_party_id)]);
      members.push({
        partyId: m.member_party_id,
        displayName: name.displayName ?? 'Member',
        membershipStatus: m.status,
        membershipId: m.id,
        planCode: m.plan_code,
        balances: purses.map((p) => toWire(p.available)),
        ...(lastSpend ? { lastSpend } : {}),
      });
    }
    members.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.partyId.localeCompare(b.partyId));
    const invites = (await this.d.invites.list(callerPartyId, now)).filter((i) => i.status === 'open').map((i) => ({ inviteId: i.id, memberName: i.memberName, membershipStatus: 'invited' as const, planCode: i.planCode, expiresAt: i.expiresAt }));
    return { id: callerPartyId, funderId: callerPartyId, members, invites };
  }

  /** One member the caller funds; any other member, or another household, answers 404 alike. */
  async member(householdId: string, memberPartyId: string, callerPartyId: string, now: Date): Promise<MemberActivity> {
    await this.requireOwn(householdId, callerPartyId);
    const funded = UUID.test(memberPartyId)
      ? await this.d.db.query(`select 1 from billing.membership where funder_party_id = $1 and member_party_id = $2 and status in ('active', 'past_due', 'paused') limit 1`, [callerPartyId, memberPartyId])
      : { rowCount: 0 };
    if (!funded.rowCount) throw new DomainError('NOT_FOUND', 'Member not found');
    const purses = await this.d.accounts.purses(memberPartyId);
    const pages = await Promise.all(purses.map((p) => this.d.transactions.forAccount(p.id, undefined)));
    const transactions = pages
      .flatMap((p) => p.items)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, 50);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const spend = await this.d.db.query<{ mcc: string | null; currency: Currency; total: string }>(
      `select j.metadata->>'mcc' as mcc, p.currency, sum(p.amount_minor)::text as total
         from ledger.journal j join ledger.posting p on p.journal_id = j.id join ledger.account a on a.id = p.account_id
        where j.kind = 'auth_hold' and a.owner_party_id = $1 and a.type = 'wallet' and p.amount_minor > 0 and j.effective_at >= $2
          and not exists (select 1 from ledger.journal x where x.kind = 'auth_release' and x.metadata->>'authId' = j.metadata->>'authId')
        group by 1, 2`,
      [memberPartyId, monthStart],
    );
    const totals = new Map<string, bigint>();
    for (const r of spend.rows) {
      const key = `${categoryOf(r.mcc ?? undefined)}|${r.currency}`;
      totals.set(key, (totals.get(key) ?? 0n) + BigInt(r.total));
    }
    const spendByCategory = [...totals.entries()]
      .map(([key, minor]) => {
        const [category, currency] = key.split('|') as [SpendCategory, Currency];
        return { category, amount: toWire(money(minor, currency)) };
      })
      .sort((a, b) => (BigInt(b.amount.minor) > BigInt(a.amount.minor) ? 1 : BigInt(b.amount.minor) < BigInt(a.amount.minor) ? -1 : a.category.localeCompare(b.category)));
    const name = await this.d.displayNames.get(memberPartyId);
    const cards = (await this.d.cards.forParty(memberPartyId)).map((c) => ({ id: c.id, type: c.type, status: c.status, last4: c.last4, lockedByFunder: c.lockedByFunder }));
    return { partyId: memberPartyId, displayName: name.displayName ?? 'Member', transactions, spendByCategory, cards };
  }

  private async requireOwn(householdId: string, callerPartyId: string): Promise<void> {
    if (!(await this.d.flags.isOn(WALLET_FLAG, { partyId: callerPartyId }))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
    if (!UUID.test(householdId) || householdId.toLowerCase() !== callerPartyId.toLowerCase()) throw new DomainError('NOT_FOUND', 'Household not found');
  }

  /** The latest card authorisation on the member's own purses: what left the purse (`auth_hold`, T-0405/T-0409). */
  private async lastSpend(partyId: string): Promise<HouseholdMember['lastSpend']> {
    const r = await this.d.db.query<{ amount_minor: string; currency: Currency; effective_at: string | Date; metadata: { mcc?: string; country?: string } }>(
      `select p.amount_minor::text as amount_minor, p.currency, j.effective_at, j.metadata
         from ledger.journal j join ledger.posting p on p.journal_id = j.id join ledger.account a on a.id = p.account_id
        where j.kind = 'auth_hold' and a.owner_party_id = $1 and a.type = 'wallet' and p.amount_minor > 0
        order by j.effective_at desc, j.created_at desc limit 1`,
      [partyId],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      amount: toWire(money(BigInt(row.amount_minor), row.currency)),
      at: new Date(row.effective_at).toISOString(),
      ...(row.metadata.mcc ? { mcc: row.metadata.mcc } : {}),
      ...(row.metadata.country ? { country: row.metadata.country } : {}),
    };
  }
}

/** GET /households/{id}: the caller's own household, as its funder. */
export function householdHandlers(households: HouseholdService): Record<string, Handler> {
  return {
    getHousehold: route(async (req) => {
      const p = requirePrincipal(req);
      return ok(await households.get(req.params['id'] ?? '', p.partyId, req.now));
    }),
    getHouseholdMember: route(async (req) => {
      const p = requirePrincipal(req);
      return ok(await households.member(req.params['id'] ?? '', req.params['partyId'] ?? '', p.partyId, req.now));
    }),
  };
}

// The funder's household (T-0534, REQ-WAL-007, P05): each member the caller pays for, from an active, past-due or
// paused membership they fund, with the member's available balance in each purse and their last card spend, and each
// open invite they sent. The household's id is the funder's own party id, and only its funder reads it: any other id
// answers 404 alike (THR-09), so a household's existence is never confirmed to someone else. What the funder may see
// follows the funder privacy notice: balances and spend, never P2P notes or concierge cases. Past-due shows the
// balance like any other: dunning never freezes money already loaded.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { FunderInvites } from '../billing/funder-invites.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { DisplayNameService } from '../me/display-name.ts';

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

export interface HouseholdDeps {
  db: Database;
  accounts: Pick<AccountService, 'purses'>;
  displayNames: Pick<DisplayNameService, 'get'>;
  invites: Pick<FunderInvites, 'list'>;
  flags: FeatureFlags;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HouseholdService {
  private readonly d: HouseholdDeps;
  constructor(d: HouseholdDeps) {
    this.d = d;
  }

  async get(householdId: string, callerPartyId: string, now: Date): Promise<Household> {
    if (!(await this.d.flags.isOn(WALLET_FLAG, { partyId: callerPartyId }))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
    // Only the funder's own household; every other id reads as not there.
    if (!UUID.test(householdId) || householdId.toLowerCase() !== callerPartyId.toLowerCase()) throw new DomainError('NOT_FOUND', 'Household not found');
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
  };
}

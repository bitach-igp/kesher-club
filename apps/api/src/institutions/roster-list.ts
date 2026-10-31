// The roster for staff (T-0638, REQ-INS-019): an institution's members, filtered by status and cohort, 50 a page by
// name then id. Each row has the member's name (as the roster has it), status, cohort, card state, balances per
// currency and plan. A row type with no spend field at all: merchant-level spend reaches staff only through the
// student's live consent (REQ-INS-005, T-0641), never here. Balances are read from the ledger's postings and never
// create accounts, so a GET writes nothing.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requireRole, route, type Handler } from '../http.ts';
import type { StaffOf } from './ach.ts';

export const PAGE = 50;
const STATUSES = ['invited', 'verified', 'active', 'declined', 'removed'] as const;
type Status = (typeof STATUSES)[number];
const CURRENCIES: readonly Currency[] = ['ILS', 'USD'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CardState = 'none' | 'inactive' | 'active' | 'frozen';

/** One roster row. Its keys are pinned by the test: nothing about where or on what a member spends. */
export interface RosterRow {
  id: string;
  name: string;
  status: Status;
  cohort?: { id: string; name: string };
  card: CardState;
  balances: ReturnType<typeof toWire>[];
  planCode?: string;
}

interface Row {
  id: string;
  member_name: string;
  status: Status;
  member_party_id: string | null;
  cohort_id: string | null;
  cohort_name: string | null;
}

const encodeCursor = (name: string, id: string): string => Buffer.from(JSON.stringify([name, id])).toString('base64url');
function decodeCursor(cursor: string | undefined): [string, string] | undefined {
  if (!cursor) return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && UUID.test(v[1])) return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new DomainError('VALIDATION_FAILED', 'cursor is not one this API gave');
}

/** The live card a staff member would care about: active, then frozen, then on its way; closed cards are not shown. */
const CARD_RANK: Record<string, number> = { active: 0, frozen: 1, inactive: 2 };

export class RosterList {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async page(institutionId: string, filter: { status?: string | undefined; cohort?: string | undefined; cursor?: string | undefined; memberId?: string | undefined }): Promise<{ items: RosterRow[]; nextCursor?: string }> {
    if (filter.status !== undefined && !(STATUSES as readonly string[]).includes(filter.status)) throw new DomainError('VALIDATION_FAILED', `status must be one of ${STATUSES.join(', ')}`);
    if (filter.cohort !== undefined && !UUID.test(filter.cohort)) throw new DomainError('VALIDATION_FAILED', 'cohort must be a cohort id');
    const after = decodeCursor(filter.cursor);
    const r = await this.db.query<Row>(
      `with cur as (select distinct on (cm.member_id) cm.member_id, cm.cohort_id from org.cohort_member cm order by cm.member_id, cm.seq desc)
       select m.id, m.member_name, m.status, m.member_party_id, c.id as cohort_id, c.name as cohort_name
         from org.member m left join cur on cur.member_id = m.id left join org.cohort c on c.id = cur.cohort_id
        where m.institution_id = $1 and ($2::text is null or m.status = $2) and ($3::uuid is null or c.id = $3)
          and ($4::text is null or (m.member_name, m.id) > ($4::text, $5::uuid))
          and ($7::uuid is null or m.id = $7)
        order by m.member_name, m.id
        limit $6`,
      [institutionId, filter.status ?? null, filter.cohort ?? null, after?.[0] ?? null, after?.[1] ?? null, PAGE + 1, filter.memberId ?? null],
    );
    const rows = r.rows.slice(0, PAGE);
    const parties = rows.map((x) => x.member_party_id).filter((x): x is string => !!x);
    const [cards, balances, plans] = parties.length ? await Promise.all([this.cards(parties), this.balances(parties), this.plans(parties)]) : [new Map(), new Map(), new Map()];
    const items = rows.map((x): RosterRow => {
      const party = x.member_party_id;
      const held = party ? (balances.get(party) ?? new Map<Currency, bigint>()) : undefined;
      return {
        id: x.id,
        name: x.member_name,
        status: x.status,
        ...(x.cohort_id && x.cohort_name ? { cohort: { id: x.cohort_id, name: x.cohort_name } } : {}),
        card: (party && cards.get(party)) || 'none',
        balances: held ? CURRENCIES.map((c) => toWire(money(held.get(c) ?? 0n, c))) : [],
        ...(party && plans.get(party) ? { planCode: plans.get(party) } : {}),
      };
    });
    const last = rows.at(-1);
    return { items, ...(r.rows.length > PAGE && last ? { nextCursor: encodeCursor(last.member_name, last.id) } : {}) };
  }

  /** One member's roster row, for the student page (T-0641); another institution's member reads as none. */
  async one(institutionId: string, memberId: string): Promise<RosterRow | undefined> {
    if (!UUID.test(memberId)) return undefined;
    return (await this.page(institutionId, { memberId })).items[0];
  }

  private async cards(parties: string[]): Promise<Map<string, CardState>> {
    const r = await this.db.query<{ party_id: string; status: string }>(`select party_id, status from cards.card where party_id = any($1::uuid[]) and status <> 'closed'`, [parties]);
    const best = new Map<string, CardState>();
    for (const c of r.rows) {
      const now = best.get(c.party_id);
      if (!now || (CARD_RANK[c.status] ?? 9) < (CARD_RANK[now] ?? 9)) best.set(c.party_id, c.status as CardState);
    }
    return best;
  }

  /** Each member's wallet balance per currency, from the postings: credit-normal, so negated. */
  private async balances(parties: string[]): Promise<Map<string, Map<Currency, bigint>>> {
    const r = await this.db.query<{ owner_party_id: string; currency: Currency; total: string }>(
      `select a.owner_party_id, p.currency, coalesce(-sum(p.amount_minor), 0)::text as total
         from ledger.account a join ledger.posting p on p.account_id = a.id
        where a.owner_party_id = any($1::uuid[]) and a.type = 'wallet'
        group by a.owner_party_id, p.currency`,
      [parties],
    );
    const out = new Map<string, Map<Currency, bigint>>();
    for (const b of r.rows) {
      const m = out.get(b.owner_party_id) ?? new Map<Currency, bigint>();
      m.set(b.currency, BigInt(b.total));
      out.set(b.owner_party_id, m);
    }
    return out;
  }

  /** The plan of each member's current membership, the latest one still running. */
  private async plans(parties: string[]): Promise<Map<string, string>> {
    const r = await this.db.query<{ member_party_id: string; plan_code: string }>(
      `select distinct on (member_party_id) member_party_id, plan_code from billing.membership
        where member_party_id = any($1::uuid[]) and status in ('active', 'past_due', 'paused') order by member_party_id, created_at desc`,
      [parties],
    );
    return new Map(r.rows.map((x) => [x.member_party_id, x.plan_code]));
  }
}

export function rosterListHandlers(roster: RosterList, staffOf: StaffOf): Record<string, Handler> {
  return {
    listInstitutionMembers: route(async (req) => {
      const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
      const institutionId = req.params['id'] ?? '';
      const staff = await staffOf(p.partyId);
      if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
      return ok(await roster.page(institutionId, { status: req.query['status'], cohort: req.query['cohort'], cursor: req.query['cursor'] }));
    }),
  };
}

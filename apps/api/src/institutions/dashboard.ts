// The institution dashboard (T-0634, REQ-INS-017): what I02 shows any active staff member of an institution:
// - the roster by status (invited, verified, active);
// - the master account's balances, from the ledger;
// - the next three allowance runs;
// - fees still due.
// Counts and sums only: no member names, member balances or spend. Another institution's staff get 404, so an
// institution's existence is not confirmed to strangers; a token with no institution role gets 403.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requireRole, route, type Handler } from '../http.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { StaffOf } from './ach.ts';
import { nextRunDate } from './allowance-runs.ts';

const CURRENCIES: readonly Currency[] = ['ILS', 'USD'];
const UPCOMING = 3;

export interface Dashboard {
  roster: { invited: number; verified: number; active: number };
  balances: ReturnType<typeof toWire>[];
  upcomingRuns: { scheduleId: string; name: string; date: string; amount: ReturnType<typeof toWire>; memberCount: number }[];
  feesDue: ReturnType<typeof toWire>[];
}

export interface DashboardDeps {
  db: Database;
  accounts: Pick<AccountService, 'institutionBalance'>;
  staffOf: StaffOf;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export class InstitutionDashboard {
  private readonly d: DashboardDeps;
  constructor(deps: DashboardDeps) {
    this.d = deps;
  }

  async read(institutionId: string, now: Date): Promise<Dashboard> {
    const { db } = this.d;
    const [statuses, schedules, fees, balances] = await Promise.all([
      db.query<{ status: string; n: number }>(`select status, count(*)::int as n from org.member where institution_id = $1 and status in ('invited', 'verified', 'active') group by status`, [institutionId]),
      db.query<{ id: string; name: string; amount_minor: string; currency: Currency; cadence: 'weekly' | 'monthly' | 'once'; member_filter: string[]; member_count: number; last_run: string | Date | null }>(
        `select s.id, s.name, s.amount_minor::text, s.currency, s.cadence, s.member_filter,
                (select count(*)::int from org.member m where m.institution_id = s.institution_id and m.status = 'active' and m.member_party_id is not null
                   and (jsonb_array_length(s.member_filter) = 0 or s.member_filter ? m.member_party_id::text)) as member_count,
                (select max(run_date) from org.allowance_run r where r.schedule_id = s.id and r.status <> 'preview') as last_run
           from org.allowance_schedule s where s.institution_id = $1 and s.active`,
        [institutionId],
      ),
      db.query<{ currency: Currency; total: string }>(`select currency, sum(amount_minor)::text as total from org.fee_item where institution_id = $1 and status = 'due' group by currency order by currency`, [institutionId]),
      Promise.all(CURRENCIES.map((c) => this.d.accounts.institutionBalance(institutionId, c))),
    ]);
    const count = (s: string) => statuses.rows.find((r) => r.status === s)?.n ?? 0;
    const today = isoDate(now);
    const upcomingRuns = schedules.rows
      .flatMap((s) => {
        const date = nextRunDate(s.cadence, s.last_run ? isoDate(new Date(s.last_run)) : undefined, today);
        return date ? [{ scheduleId: s.id, name: s.name, date, amount: toWire(money(BigInt(s.amount_minor), s.currency)), memberCount: s.member_count }] : [];
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.scheduleId.localeCompare(b.scheduleId))
      .slice(0, UPCOMING);
    return {
      roster: { invited: count('invited'), verified: count('verified'), active: count('active') },
      balances: balances.map(toWire),
      upcomingRuns,
      feesDue: fees.rows.map((f) => toWire(money(BigInt(f.total), f.currency))),
    };
  }

  /** Any active staff role of this institution; another institution's staff read 404. */
  async forStaff(partyId: string, institutionId: string, now: Date): Promise<Dashboard> {
    const staff = await this.d.staffOf(partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    return this.read(institutionId, now);
  }
}

export function dashboardHandlers(dashboard: InstitutionDashboard): Record<string, Handler> {
  return {
    getInstitutionDashboard: route(async (req) => {
      const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
      return ok(await dashboard.forStaff(p.partyId, req.params['id'] ?? '', req.now));
    }),
  };
}

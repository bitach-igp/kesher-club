// One student for staff (T-0641, REQ-INS-005, REQ-INS-019): the roster row, the allowances paid to them (latest
// 20) and their fee items due and paid. Merchant-level spend is returned only while the student's `spend_detail`
// consent to this institution is live. Without it the field is absent, not empty, so "no consent" never reads as
// "spent nothing". Two layers guard it: the code reads the consent first, and the spend read runs with
// `app.institution_id` set for that transaction, so Postgres's row-level security on org.member_spend (T-0603) agrees
// when the API runs as club_app. Merchant names are untrusted text and travel as data.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requireRole, route, type Handler } from '../http.ts';
import type { StaffOf } from './ach.ts';
import type { RosterList, RosterRow } from './roster-list.ts';

const ALLOWANCES = 20;
const SPEND = 50;

type Wire = ReturnType<typeof toWire>;

export interface Student {
  member: RosterRow;
  allowances: { date: string; amount: Wire; status: 'pending' | 'paid' | 'failed' }[];
  fees: { id: string; description: string; amount: Wire; dueAt: string; status: 'due' | 'paid' | 'waived' }[];
  /** Present only while the student's consent is live. */
  spend?: { merchant: string; mcc: string; amount: Wire; at: string }[];
}

const day = (v: string | Date): string => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

export class StudentDetail {
  private readonly db: Database;
  private readonly roster: Pick<RosterList, 'one'>;
  constructor(db: Database, roster: Pick<RosterList, 'one'>) {
    this.db = db;
    this.roster = roster;
  }

  async read(institutionId: string, memberId: string): Promise<Student> {
    const member = await this.roster.one(institutionId, memberId);
    if (!member) throw new DomainError('NOT_FOUND', 'Student not found');
    const party = (await this.db.query<{ member_party_id: string | null }>('select member_party_id from org.member where id = $1', [memberId])).rows[0]?.member_party_id;
    if (!party) return { member, allowances: [], fees: [] };

    const [allowances, fees, consent] = await Promise.all([
      this.db.query<{ run_date: string | Date; amount_minor: string; currency: Currency; status: 'pending' | 'paid' | 'failed' }>(
        `select r.run_date, s.amount_minor::text, s.currency, p.status
           from org.allowance_payment p join org.allowance_run r on r.workflow_id = p.workflow_id join org.allowance_schedule s on s.id = r.schedule_id
          where p.member_party_id = $1 and s.institution_id = $2 order by r.run_date desc, r.workflow_id desc limit ${ALLOWANCES}`,
        [party, institutionId],
      ),
      this.db.query<{ id: string; description: string; amount_minor: string; currency: Currency; due_at: string | Date; status: 'due' | 'paid' | 'waived' }>(
        `select id, description, amount_minor::text, currency, due_at, status from org.fee_item where institution_id = $1 and member_party_id = $2 order by due_at desc, id`,
        [institutionId, party],
      ),
      this.db.query(`select 1 from org.consent_grant where member_party_id = $1 and institution_id = $2 and scope = 'spend_detail' and revoked_at is null`, [party, institutionId]),
    ]);
    const out: Student = {
      member,
      allowances: allowances.rows.map((a) => ({ date: day(a.run_date), amount: toWire(money(BigInt(a.amount_minor), a.currency)), status: a.status })),
      fees: fees.rows.map((f) => ({ id: f.id, description: f.description, amount: toWire(money(BigInt(f.amount_minor), f.currency)), dueAt: day(f.due_at), status: f.status })),
    };
    if (!consent.rowCount) return out;
    const spend = await this.db.transaction(async (tx) => {
      await tx.query(`select set_config('app.institution_id', $1, true)`, [institutionId]);
      return tx.query<{ merchant_name: string; mcc: string; amount_minor: string; currency: Currency; at: string | Date }>(
        `select merchant_name, mcc, amount_minor::text, currency, at from org.member_spend where institution_id = $1 and member_party_id = $2 order by at desc, id desc limit ${SPEND}`,
        [institutionId, party],
      );
    });
    return { ...out, spend: spend.rows.map((x) => ({ merchant: x.merchant_name, mcc: x.mcc, amount: toWire(money(BigInt(x.amount_minor), x.currency)), at: new Date(x.at).toISOString() })) };
  }
}

export function studentHandlers(students: StudentDetail, staffOf: StaffOf): Record<string, Handler> {
  return {
    getInstitutionMember: route(async (req) => {
      const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
      const institutionId = req.params['id'] ?? '';
      const staff = await staffOf(p.partyId);
      if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
      return ok(await students.read(institutionId, req.params['memberId'] ?? ''));
    }),
  };
}

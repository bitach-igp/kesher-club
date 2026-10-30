// Plans and plan versions (T-0302). Versions are immutable: a price or entitlement change is a
// new version; existing memberships keep the version (and price) they started on for the term.
// T-0932: a version finance proposes waits `proposed` until a second finance member approves it
// (plan-catalogue.ts); only an `active` version is offered to a new member.
import { DomainError, type Currency, type Money } from '@kesher/domain';
import type { Database } from '../db.ts';

export type EntitlementPeriod = 'month' | 'term' | 'none';

/** FX markup when a plan version names none, and for members without an active plan (REQ-FX-002). */
export const DEFAULT_FX_MARKUP_BPS = 75n;

export interface EntitlementTemplate {
  /** Integer as a string (bigint-safe in jsonb). */
  limit: string;
  unit: 'gb' | 'calls' | 'minor' | 'count';
  period: EntitlementPeriod;
}

export type EntitlementTemplates = Record<string, EntitlementTemplate>;

/** Who proposed a version that waits for a second finance approver (T-0932), and why. */
export interface Proposal {
  by: string;
  reason: string;
  market: 'IL' | 'US';
}

export interface PlanVersion {
  planCode: string;
  version: number;
  price: Money;
  termMonths: number;
  entitlements: EntitlementTemplates;
  fxMarkupBps: bigint;
  effectiveFrom: string;
}

interface Row {
  plan_code: string;
  version: number;
  price_minor: string;
  currency: Currency;
  term_months: number;
  entitlements: EntitlementTemplates;
  fx_markup_bps: number;
  effective_from: string | Date;
}

export class PlanService {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async ensurePlan(code: string, name: string): Promise<void> {
    await this.db.query('insert into billing.plan (code, name) values ($1, $2) on conflict (code) do nothing', [code, name]);
  }

  /** Appends the next version. Never updates an existing one. */
  async createVersion(input: { planCode: string; price: Money; termMonths: number; entitlements: EntitlementTemplates; fxMarkupBps?: bigint; effectiveFrom: Date; proposal?: Proposal }): Promise<PlanVersion> {
    for (const [key, t] of Object.entries(input.entitlements)) {
      if (!/^\d+$/.test(t.limit)) throw new DomainError('VALIDATION_FAILED', `Entitlement ${key} limit must be an integer string`);
    }
    return this.db.transaction(async (tx) => {
      const last = await tx.query<{ v: number | null }>('select max(version) as v from billing.plan_version where plan_code = $1', [input.planCode]);
      const version = (last.rows[0]?.v ?? 0) + 1;
      await tx.query(
        `insert into billing.plan_version (plan_code, version, price_minor, currency, term_months, entitlements, fx_markup_bps, effective_from, state, market, proposed_by, reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [input.planCode, version, input.price.minor.toString(), input.price.currency, input.termMonths, JSON.stringify(input.entitlements), Number(input.fxMarkupBps ?? DEFAULT_FX_MARKUP_BPS), input.effectiveFrom, input.proposal ? 'proposed' : 'active', input.proposal?.market ?? null, input.proposal?.by ?? null, input.proposal?.reason ?? null],
      );
      return (await this.get(input.planCode, version, tx))!;
    });
  }

  /** The version offered at `at`: the latest approved one whose effective_from ≤ at. A proposed or rejected one never is. */
  async current(planCode: string, at: Date): Promise<PlanVersion> {
    const r = await this.db.query<Row>(`select * from billing.plan_version where plan_code = $1 and effective_from <= $2 and state = 'active' order by version desc limit 1`, [planCode, at]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', `No plan version for ${planCode}`);
    return toVersion(r.rows[0]);
  }

  async get(planCode: string, version: number, db: Pick<Database, 'query'> = this.db): Promise<PlanVersion | undefined> {
    const r = await db.query<Row>('select * from billing.plan_version where plan_code = $1 and version = $2', [planCode, version]);
    return r.rows[0] ? toVersion(r.rows[0]) : undefined;
  }
}

function toVersion(r: Row): PlanVersion {
  return { planCode: r.plan_code, version: r.version, price: { minor: BigInt(r.price_minor), currency: r.currency }, termMonths: r.term_months, entitlements: r.entitlements, fxMarkupBps: BigInt(r.fx_markup_bps), effectiveFrom: new Date(r.effective_from).toISOString() };
}

// Cohorts (T-0636, REQ-INS-018): an institution groups its roster into cohorts, each with a start and an end date,
// and places members in one. Any staff role may do it: coordinators keep the roster (spec, roles), and moving a
// member between cohorts moves no money. Placements are insert-only; a member's cohort is the latest. A batch of
// up to 500 is all or nothing: one member or cohort of another institution and nobody is placed. Another
// institution reads as not found.
import { DomainError, uuidv7 } from '@kesher/domain';
import { isPgError, PG, type Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, requireRole, route, type Handler } from '../http.ts';
import type { StaffOf } from './ach.ts';

export const MAX_BATCH = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Cohort {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  /** Members whose latest placement is this cohort. */
  memberCount: number;
}

interface CohortRow {
  id: string;
  name: string;
  starts_on: string | Date;
  ends_on: string | Date;
  member_count: number;
}

const day = (v: string | Date): string => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const realDate = (s: string): boolean => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function parseCohort(body: unknown): { name: string; startsOn: string; endsOn: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
  if (!name || name.length > 120) throw new DomainError('VALIDATION_FAILED', 'name must be 1 to 120 characters');
  const startsOn = typeof b['startsOn'] === 'string' ? b['startsOn'] : '';
  const endsOn = typeof b['endsOn'] === 'string' ? b['endsOn'] : '';
  if (!realDate(startsOn) || !realDate(endsOn)) throw new DomainError('VALIDATION_FAILED', 'startsOn and endsOn must be dates, YYYY-MM-DD');
  if (endsOn <= startsOn) throw new DomainError('VALIDATION_FAILED', 'endsOn must be after startsOn');
  return { name, startsOn, endsOn };
}

/** The latest placement per member, as a subquery: the member's current cohort. */
const CURRENT = `select distinct on (cm.member_id) cm.member_id, cm.cohort_id from org.cohort_member cm order by cm.member_id, cm.seq desc`;

export class Cohorts {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async list(institutionId: string): Promise<Cohort[]> {
    const r = await this.db.query<CohortRow>(
      `select c.id, c.name, c.starts_on, c.ends_on, (select count(*)::int from (${CURRENT}) cur where cur.cohort_id = c.id) as member_count
         from org.cohort c where c.institution_id = $1 order by c.starts_on desc, c.name, c.id`,
      [institutionId],
    );
    return r.rows.map(view);
  }

  /** Creates the cohort once per key; a retry with the same key and body answers it. */
  async create(institutionId: string, body: unknown, key: string, by: string, now: Date): Promise<Cohort> {
    const c = parseCohort(body);
    const replay = async () => {
      const r = await this.db.query<{ id: string; institution_id: string; name: string }>('select id, institution_id, name from org.cohort where idempotency_key = $1', [key]);
      const row = r.rows[0];
      if (!row) return undefined;
      if (row.institution_id !== institutionId || row.name !== c.name) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key made a different cohort');
      return this.get(institutionId, row.id);
    };
    const seen = await replay();
    if (seen) return seen;
    const id = uuidv7(now);
    try {
      await this.db.query('insert into org.cohort (id, institution_id, idempotency_key, name, starts_on, ends_on, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', [id, institutionId, key, c.name, c.startsOn, c.endsOn, by, now]);
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) {
        const won = await replay();
        if (won) return won;
      }
      throw e;
    }
    return (await this.get(institutionId, id))!;
  }

  /** Places roster members in the cohort, all or none; a retried batch places nobody twice. */
  async place(institutionId: string, cohortId: string, body: unknown, key: string, by: string, now: Date): Promise<{ cohort: Cohort; placed: number }> {
    const ids = (body as { memberIds?: unknown } | undefined)?.memberIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH || !ids.every((x): x is string => typeof x === 'string' && UUID.test(x))) {
      throw new DomainError('VALIDATION_FAILED', `memberIds must be 1 to ${MAX_BATCH} roster member ids`);
    }
    const memberIds = [...new Set(ids.map((x) => x.toLowerCase()))];
    const cohort = UUID.test(cohortId) ? await this.get(institutionId, cohortId) : undefined;
    if (!cohort) throw new DomainError('NOT_FOUND', 'Cohort not found');
    const placed = await this.db.transaction(async (tx) => {
      const own = await tx.query<{ id: string }>('select id from org.member where institution_id = $1 and id = any($2::uuid[])', [institutionId, memberIds]);
      if (own.rows.length !== memberIds.length) throw new DomainError('NOT_FOUND', 'One or more members are not on this roster');
      let n = 0;
      for (const memberId of memberIds) {
        const r = await tx.query('insert into org.cohort_member (id, cohort_id, member_id, idempotency_key, placed_by, placed_at) values ($1, $2, $3, $4, $5, $6) on conflict (idempotency_key, member_id) do nothing', [uuidv7(now), cohortId, memberId, key, by, now]);
        n += r.rowCount ?? 0;
      }
      return n;
    });
    return { cohort: (await this.get(institutionId, cohortId))!, placed };
  }

  private async get(institutionId: string, id: string): Promise<Cohort | undefined> {
    const r = await this.db.query<CohortRow>(
      `select c.id, c.name, c.starts_on, c.ends_on, (select count(*)::int from (${CURRENT}) cur where cur.cohort_id = c.id) as member_count
         from org.cohort c where c.institution_id = $1 and c.id = $2`,
      [institutionId, id],
    );
    return r.rows[0] ? view(r.rows[0]) : undefined;
  }
}

const view = (r: CohortRow): Cohort => ({ id: r.id, name: r.name, startsOn: day(r.starts_on), endsOn: day(r.ends_on), memberCount: r.member_count });

export function cohortHandlers(cohorts: Cohorts, staffOf: StaffOf): Record<string, Handler> {
  /** Any active staff role of this institution; another institution reads as not found. */
  const own = async (req: Parameters<Handler>[0]) => {
    const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    const staff = await staffOf(p.partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    return { institutionId, partyId: p.partyId };
  };
  return {
    listCohorts: route(async (req) => {
      const { institutionId } = await own(req);
      return ok({ items: await cohorts.list(institutionId) });
    }),
    createCohort: route(async (req) => {
      const { institutionId, partyId } = await own(req);
      return created(await cohorts.create(institutionId, req.body, requireIdempotencyKey(req), partyId, req.now));
    }),
    placeCohortMembers: route(async (req) => {
      const { institutionId, partyId } = await own(req);
      return ok(await cohorts.place(institutionId, req.params['cohortId'] ?? '', req.body, requireIdempotencyKey(req), partyId, req.now));
    }),
  };
}

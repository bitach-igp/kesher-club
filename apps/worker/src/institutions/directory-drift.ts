// Directory drift sweep (T-0791, REQ-AUTH-008): a lost or late WorkOS webhook must not leave a removed person with access. Every 10
// minutes, for each institution with a live staff link, ONE `listDirectory` call is compared with `org.staff_idp_link`; whoever the
// directory positively lists inactive, or (see below) no longer lists, goes through the SAME removal as the webhook
// (`StaffDeprovisioner.remove`: row, audit and unlink in one transaction, then role and sessions). Dark behind `auth.orgSso`.
// - The institution comes only from the per-organisation record (`directoryInstitutions`), never from directory text.
// - A read that fails, or a list that cannot be trusted, is never read as "everyone left": any port error changes nothing and fails the
//   cycle (after every other institution was swept); a malformed entry, an entry whose raw `rawState` is not exactly `active` or `inactive`
//   (missing, new, or at odds with `active`: SUSPECT, T-1116), or a list with no active entry at all, switches ABSENCE off for that
//   institution (only a positive `inactive` still counts, and a suspect subject is never removed); and more than half of an institution's links in one cycle is
//   refused, with an audit row (once a day per institution) and a metric. The refusal is not an `ops.case`: a new case kind needs the
//   OpenAPI enum, the SDK and the admin types (T-0788), which is outside this card. `listDirectory` pages internally and throws on
//   any failed page, so a list it returns is complete; a truncated one cannot reach this code.
// - One bad institution never starves the others: errors are counted by a closed reason and the loop goes on. Nothing is queued.
// - A removal whose post-commit steps failed is finished by the next cycles however late (drift audit rows with no `deprovision_finished`
//   marker; the marker is written once `finish` completes, so a finished one never revokes a newer session).
// - A link younger than 24 hours is not removed for ABSENCE (SCIM sync lags); a positive inactive is never graced. The port
//   exposes the raw directory state (`rawState`), so a suspect state is told apart from a positive inactive.
// - Audit payloads carry ids and the closed `drift_missing` flag only: no email, no subject.
import type { AuditService } from '@kesher/api/audit/service';
import type { FeatureFlags } from '@kesher/api/billing/capabilities';
import type { Database } from '@kesher/api/db';
import { putMarker } from '@kesher/api/ops/workflow-marker';
import { ORG_SSO_FLAG, removalKey, type StaffDeprovisioner } from '@kesher/api/institutions/staff-deprovision';
import { guarded, type Metrics } from '@kesher/domain';
import { OrgIdPError, type OrgIdPPort } from '@kesher/ports';

export const DRIFT_CYCLE_MS = 10 * 60_000;
/** A link younger than this is not removed for ABSENCE: SCIM sync can lag the link by tens of minutes. A positive inactive is never graced. */
const NEW_LINK_GRACE_MS = 24 * 3_600_000;
/** Resume: rows per page, attempts per cycle, and failed attempts before a removal is abandoned (and shown, never dropped). */
const RESUME_BATCH = 100;
const RESUME_CAP = 500;
const MAX_ATTEMPTS = 20;
/** The closed set of `reason` values `staff.drift_refused` carries (an adapter's lower-cased error code, or one of these). */
export const DRIFT_REFUSAL_REASONS = ['malformed_entry', 'unrecognised_state', 'unreliable_list', 'guard_half', 'removal_failed', 'finish_failed'] as const;
const SYSTEM = { actorId: '00000000-0000-7000-8000-000000000000', actorRole: 'system' };
const SOURCE = 'drift';

export interface DriftResult {
  skipped?: 'flag_off' | 'no_binding';
  institutions: number;
  corrected: number;
  /** Directory users with no live link: counted, never acted on. */
  unlinked: number;
  refused: number;
  failed: number;
  /** Removals given up on this cycle after too many failed finishes. */
  abandoned?: number;
}

/** Thrown after the whole sweep when any institution could not be read or removed: the scheduler logs it and runs again next cycle. */
export class DriftCycleFailed extends Error {
  readonly code = 'DRIFT_CYCLE_FAILED';
  readonly result: DriftResult;
  constructor(result: DriftResult) {
    super(`directory drift: ${result.failed} failed`);
    this.name = 'DriftCycleFailed';
    this.result = result;
  }
}

export interface DirectoryDriftDeps {
  db: Database;
  audit: AuditService;
  flags: FeatureFlags;
  /** The market's `org-idp` port, or undefined when it has no binding. */
  port: () => OrgIdPPort | undefined;
  deprovision: Pick<StaffDeprovisioner, 'remove' | 'finish' | 'institutions'> | undefined;
  metrics: Metrics;
  clock: () => Date;
  resume?: { batch?: number; cap?: number; maxAttempts?: number };
}

interface Link {
  id: string;
  linkedAt: number;
  subject: string;
  partyId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** A closed set of metric reasons: an adapter's error code (lower-case) or one of ours. */
const reasonOf = (e: unknown): string => (e instanceof OrgIdPError ? e.code.toLowerCase() : 'error');

export class DirectoryDrift {
  private readonly d: DirectoryDriftDeps;
  private readonly metrics: Metrics;
  /** Where the last resume stopped: the next cycle starts after it, so rows that keep failing never starve the ones behind them. */
  private cursor = 0;
  constructor(deps: DirectoryDriftDeps) {
    this.d = deps;
    this.metrics = guarded(deps.metrics);
  }

  /** One cycle. Flag off or no binding does nothing; a flag service that throws fails closed (nothing is read, the throw reaches the scheduler). */
  async run(): Promise<DriftResult> {
    const out: DriftResult = { institutions: 0, corrected: 0, unlinked: 0, refused: 0, failed: 0 };
    const port = this.d.port();
    if (!port || !this.d.deprovision) return { ...out, skipped: 'no_binding' };
    if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) return { ...out, skipped: 'flag_off' };
    const now = this.d.clock();
    await this.resume(out);
    for (const institutionId of this.d.deprovision.institutions()) {
      if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) {
        out.skipped = 'flag_off';
        break;
      }
      try {
        if (!(await this.sweep(port, institutionId, now, out))) {
          out.skipped = 'flag_off';
          break;
        }
      } catch (e) {
        out.failed += 1;
        this.metrics.put({ 'staff.drift_refused': 1 }, { reason: reasonOf(e) });
      }
    }
    if (out.failed > 0) throw new DriftCycleFailed(out);
    return out;
  }

  /** Nightly, information only: directory users with no live link, counted per institution (including ones with no link at all). */
  async report(): Promise<{ institutions: number; unlinked: number; failed: number; skipped?: 'flag_off' | 'no_binding' }> {
    const out = { institutions: 0, unlinked: 0, failed: 0 };
    const port = this.d.port();
    if (!port || !this.d.deprovision) return { ...out, skipped: 'no_binding' };
    if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) return { ...out, skipped: 'flag_off' };
    for (const institutionId of this.d.deprovision.institutions()) {
      out.institutions += 1;
      try {
        const links = await this.links(institutionId);
        const read = this.read(await port.listDirectory(institutionId));
        out.unlinked += read.entries.filter((e) => !links.some((l) => l.subject === e.subject)).length;
      } catch (e) {
        out.failed += 1;
        this.metrics.put({ 'staff.drift_refused': 1 }, { reason: reasonOf(e) });
      }
    }
    this.metrics.put({ 'staff.directory_unlinked': out.unlinked });
    if (out.failed > 0) throw new DriftCycleFailed({ ...out, corrected: 0, refused: 0 });
    return out;
  }

  /** False when the flag went off part-way and the cycle must stop. */
  private async sweep(port: OrgIdPPort, institutionId: string, now: Date, out: DriftResult): Promise<boolean> {
    const links = await this.links(institutionId);
    if (links.length === 0) return true; // no live link, nothing to correct and no list call
    out.institutions += 1;
    const read = this.read(await port.listDirectory(institutionId));
    if (read.malformed > 0) this.metrics.put({ 'staff.drift_refused': read.malformed }, { reason: 'malformed_entry' });
    const suspect = new Set(read.entries.filter((e) => e.suspect).map((e) => e.subject));
    const suspects = read.entries.filter((e) => e.suspect).length;
    if (suspects > 0) this.metrics.put({ 'staff.drift_refused': suspects }, { reason: 'unrecognised_state' });
    const bySubject = new Map<string, boolean>();
    // A subject listed twice counts as active if either entry is: when in doubt, nobody is removed. A suspect entry says nothing either way.
    for (const e of read.entries) if (!e.suspect) bySubject.set(e.subject, (bySubject.get(e.subject) ?? false) || e.active);
    out.unlinked += [...new Set([...bySubject.keys(), ...suspect])].filter((s) => !links.some((l) => l.subject === s)).length;
    const trustAbsence = read.malformed === 0 && suspects === 0 && [...bySubject.values()].some(Boolean);
    const candidates: { link: Link; missing: boolean }[] = [];
    let doubtful = 0;
    for (const link of links) {
      if (suspect.has(link.subject) && bySubject.get(link.subject) !== true) continue; // an unrecognised state is never a reason to remove (and counted above)
      const active = bySubject.get(link.subject);
      if (active === false) candidates.push({ link, missing: false });
      else if (active === undefined) {
        if (link.linkedAt > now.getTime() - NEW_LINK_GRACE_MS) continue; // freshly linked: the directory may not list them yet
        if (trustAbsence) candidates.push({ link, missing: true });
        else doubtful += 1;
      }
    }
    if (doubtful > 0) this.metrics.put({ 'staff.drift_refused': doubtful }, { reason: 'unreliable_list' });
    if (candidates.length === 0) return true;
    if (candidates.length * 2 > links.length) {
      out.refused += 1;
      this.metrics.put({ 'staff.drift_refused': 1 }, { reason: 'guard_half' });
      await this.recordRefusal(institutionId, links.length, candidates.length, now);
      return true;
    }
    for (const { link, missing } of candidates) {
      if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) return false; // turned off mid-cycle: no further removal
      try {
        const removed = await this.d.deprovision!.remove(institutionId, link.subject, `${SOURCE}:${link.id}`, now, {
          reason: 'Directory drift sweep',
          payload: { source: SOURCE, drift_missing: missing },
          linkId: link.id,
        });
        if (!removed) continue;
        out.corrected += 1;
        this.metrics.put({ 'staff.drift_corrected': 1 }, { reason: missing ? 'missing' : 'inactive' });
      } catch {
        out.failed += 1;
        this.metrics.put({ 'staff.drift_refused': 1 }, { reason: 'removal_failed' });
      }
    }
    return true;
  }

  /** Valid entries (a non-empty subject of at most 255 characters and a boolean `active`); everything else is only counted. An entry is suspect unless `rawState` is `active` with `active` true, or `inactive` with `active` false. */
  private read(list: unknown): { entries: { subject: string; active: boolean; suspect: boolean }[]; malformed: number } {
    if (!Array.isArray(list)) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'The directory list is not a list');
    const entries: { subject: string; active: boolean; suspect: boolean }[] = [];
    let malformed = 0;
    for (const e of list as unknown[]) {
      if (isRecord(e) && typeof e['subject'] === 'string' && e['subject'].length > 0 && e['subject'].length <= 255 && typeof e['active'] === 'boolean') entries.push({ subject: e['subject'], active: e['active'], suspect: !(e['rawState'] === 'active' ? e['active'] : e['rawState'] === 'inactive' && !e['active']) });
      else malformed += 1;
    }
    return { entries, malformed };
  }

  private async links(institutionId: string): Promise<Link[]> {
    const r = await this.d.db.query<{ id: string; idp_subject: string; party_id: string; linked_at: string | Date }>('select id, idp_subject, party_id, linked_at from org.staff_idp_link where institution_id = $1 and unlinked_at is null order by id', [institutionId]);
    return r.rows.map((x) => ({ id: x.id, subject: x.idp_subject, partyId: x.party_id, linkedAt: new Date(x.linked_at).getTime() }));
  }

  /** The refusal is an audit row, written once a day per institution so a standing refusal cannot grow the log every cycle. */
  private async recordRefusal(institutionId: string, linked: number, candidates: number, now: Date): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    const seen = await this.d.db.query("select 1 from audit.entry where action = 'institution.staff.drift_refused' and subject = $1 and payload->>'day' = $2", [institutionId, day]);
    if (seen.rowCount > 0) return;
    await this.d.audit.record({ ...SYSTEM, action: 'institution.staff.drift_refused', subject: institutionId, reason: 'Directory drift would remove more than half of the linked staff', payload: { institutionId, day, linked, candidates, reason: 'guard_half' } }, now);
  }

  /**
   * Finishes drift removals whose role or session step failed after the commit: every drift audit row with no `deprovision_finished` and no
   * `deprovision_abandoned` marker, however old. Rows are paged by `seq` from a cursor that persists between cycles (and wraps), at most
   * `cap` attempts per cycle, so a row that keeps failing never blocks the ones behind it. Each failed attempt is a write-once attempt marker;
   * after `maxAttempts` the removal is abandoned: a terminal marker, an audit row and `staff.drift_finish_abandoned`, then it is not retried.
   * The select is an anti-join over drift audit rows (no index on `source`): bounded by the number of drift removals ever made, with no migration.
   */
  private async resume(out: DriftResult): Promise<void> {
    const batch = this.d.resume?.batch ?? RESUME_BATCH;
    let budget = this.d.resume?.cap ?? RESUME_CAP;
    const start = this.cursor;
    let wrapped = false;
    while (budget > 0) {
      const rows = await this.unfinished(this.cursor, wrapped ? start : undefined, Math.min(batch, budget));
      if (rows.length === 0) {
        if (wrapped || this.cursor === 0) {
          this.cursor = 0;
          return;
        }
        this.cursor = 0;
        wrapped = true;
        continue;
      }
      for (const row of rows) {
        budget -= 1;
        this.cursor = row.seq;
        await this.attempt(row, out);
      }
    }
  }

  private async unfinished(after: number, upto: number | undefined, limit: number) {
    const r = await this.d.db.query<{ seq: string | number; subject: string; payload: { institutionId?: string; eventId?: string; adminNone?: boolean } }>(
      `select a.seq, a.subject, a.payload from audit.entry a
        where a.action = 'institution.staff.deprovision' and a.payload->>'source' = $1 and a.seq > $2 and ($3::bigint is null or a.seq <= $3::bigint)
          and not exists (select 1 from ops.workflow_marker m where m.subject_id = a.subject::uuid
                and m.kind in ('deprovision_finished:' || (a.payload->>'institutionId') || ':' || encode(sha256(convert_to(a.payload->>'eventId', 'UTF8')), 'hex'),
                               'deprovision_abandoned:' || (a.payload->>'institutionId') || ':' || encode(sha256(convert_to(a.payload->>'eventId', 'UTF8')), 'hex')))
        order by a.seq limit $4`,
      [SOURCE, after, upto ?? null, limit],
    );
    return r.rows.map((x) => ({ seq: Number(x.seq), subject: x.subject, payload: x.payload }));
  }

  private async attempt(row: { subject: string; payload: { institutionId?: string; eventId?: string; adminNone?: boolean } }, out: DriftResult): Promise<void> {
    const { institutionId, eventId } = row.payload;
    if (!institutionId || !eventId) return;
    try {
      await this.d.deprovision!.finish({ institutionId, partyId: row.subject, eventId, adminNone: row.payload.adminNone === true });
    } catch {
      out.failed += 1;
      this.metrics.put({ 'staff.drift_refused': 1 }, { reason: 'finish_failed' });
      const key = removalKey(institutionId, eventId);
      const kind = `deprovision_attempt:${key}`;
      const n = (await this.d.db.query<{ n: number }>('select count(*)::int as n from ops.workflow_marker where kind = $1 and subject_id = $2', [kind, row.subject])).rows[0]!.n;
      await putMarker(this.d.db, { kind, subjectId: row.subject, seq: n, value: 'failed' });
      if (n + 1 < (this.d.resume?.maxAttempts ?? MAX_ATTEMPTS)) return;
      const now = this.d.clock();
      await putMarker(this.d.db, { kind: `deprovision_abandoned:${key}`, subjectId: row.subject, value: 'abandoned' });
      await this.d.audit.record({ ...SYSTEM, action: 'institution.staff.drift_finish_abandoned', subject: row.subject, reason: 'The role and session step of a drift removal failed repeatedly and is no longer retried', payload: { institutionId, eventId, attempts: n + 1 } }, now);
      this.metrics.put({ 'staff.drift_finish_abandoned': 1 });
      out.abandoned = (out.abandoned ?? 0) + 1;
    }
  }
}

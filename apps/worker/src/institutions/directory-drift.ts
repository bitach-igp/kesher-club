// Directory drift sweep (T-0791, REQ-AUTH-008): a lost or late WorkOS webhook must not leave a removed person with access. Every 10
// minutes, for each institution with a live staff link, ONE `listDirectory` call is compared with `org.staff_idp_link`; whoever the
// directory positively lists inactive, or (see below) no longer lists, goes through the SAME removal as the webhook
// (`StaffDeprovisioner.remove`: row, audit and unlink in one transaction, then role and sessions). Dark behind `auth.orgSso`.
// - The institution comes only from the per-organisation record (`directoryInstitutions`), never from directory text.
// - A read that fails, or a list that cannot be trusted, is never read as "everyone left": any port error changes nothing and fails the
//   cycle (after every other institution was swept); a malformed entry, or a list with no active entry at all, switches ABSENCE off for
//   that institution (only a positive `active: false` still counts); and more than half of an institution's links in one cycle is
//   refused, with an audit row (once a day per institution) and a metric. The refusal is not an `ops.case`: a new case kind needs the
//   OpenAPI enum, the SDK and the admin types (T-0788), which is outside this card. `listDirectory` pages internally and throws on
//   any failed page, so a list it returns is complete; a truncated one cannot reach this code.
// - One bad institution never starves the others: errors are counted by a closed reason and the loop goes on. Nothing is queued.
// - A removal whose post-commit steps failed is finished by the next cycles (drift audit rows of the last hour), never forgotten.
// - Audit payloads carry ids and the closed `drift_missing` flag only: no email, no subject.
import type { AuditService } from '@kesher/api/audit/service';
import type { FeatureFlags } from '@kesher/api/billing/capabilities';
import type { Database } from '@kesher/api/db';
import { ORG_SSO_FLAG, type StaffDeprovisioner } from '@kesher/api/institutions/staff-deprovision';
import { guarded, type Metrics } from '@kesher/domain';
import { OrgIdPError, type OrgIdPPort } from '@kesher/ports';

export const DRIFT_CYCLE_MS = 10 * 60_000;
const RESUME_WINDOW_MS = 60 * 60_000;
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
}

interface Link {
  id: string;
  subject: string;
  partyId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** A closed set of metric reasons: an adapter's error code (lower-case) or one of ours. */
const reasonOf = (e: unknown): string => (e instanceof OrgIdPError ? e.code.toLowerCase() : 'error');

export class DirectoryDrift {
  private readonly d: DirectoryDriftDeps;
  private readonly metrics: Metrics;
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
    await this.resume(now, out);
    for (const institutionId of this.d.deprovision.institutions()) {
      if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) return { ...out, skipped: 'flag_off' };
      try {
        await this.sweep(port, institutionId, now, out);
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

  private async sweep(port: OrgIdPPort, institutionId: string, now: Date, out: DriftResult): Promise<void> {
    const links = await this.links(institutionId);
    if (links.length === 0) return; // no live link, nothing to correct and no list call
    out.institutions += 1;
    const read = this.read(await port.listDirectory(institutionId));
    if (read.malformed > 0) this.metrics.put({ 'staff.drift_refused': read.malformed }, { reason: 'malformed_entry' });
    const bySubject = new Map<string, boolean>();
    // A subject listed twice counts as active if either entry is: when in doubt, nobody is removed.
    for (const e of read.entries) bySubject.set(e.subject, (bySubject.get(e.subject) ?? false) || e.active);
    out.unlinked += [...bySubject.keys()].filter((s) => !links.some((l) => l.subject === s)).length;
    const trustAbsence = read.malformed === 0 && [...bySubject.values()].some(Boolean);
    const candidates: { link: Link; missing: boolean }[] = [];
    let doubtful = 0;
    for (const link of links) {
      const active = bySubject.get(link.subject);
      if (active === false) candidates.push({ link, missing: false });
      else if (active === undefined) {
        if (trustAbsence) candidates.push({ link, missing: true });
        else doubtful += 1;
      }
    }
    if (doubtful > 0) this.metrics.put({ 'staff.drift_refused': doubtful }, { reason: 'unreliable_list' });
    if (candidates.length === 0) return;
    if (candidates.length * 2 > links.length) {
      out.refused += 1;
      this.metrics.put({ 'staff.drift_refused': 1 }, { reason: 'guard_half' });
      await this.recordRefusal(institutionId, links.length, candidates.length, now);
      return;
    }
    for (const { link, missing } of candidates) {
      try {
        const removed = await this.d.deprovision!.remove(institutionId, link.subject, `${SOURCE}:${link.id}`, now, {
          reason: 'Directory drift sweep',
          payload: { source: SOURCE, drift_missing: missing },
        });
        if (!removed) continue;
        out.corrected += 1;
        this.metrics.put({ 'staff.drift_corrected': 1 }, { reason: missing ? 'missing' : 'inactive' });
      } catch {
        out.failed += 1;
        this.metrics.put({ 'staff.drift_refused': 1 }, { reason: 'removal_failed' });
      }
    }
  }

  /** Valid entries (a non-empty subject of at most 255 characters and a boolean `active`); everything else is only counted. */
  private read(list: unknown): { entries: { subject: string; active: boolean }[]; malformed: number } {
    if (!Array.isArray(list)) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'The directory list is not a list');
    const entries: { subject: string; active: boolean }[] = [];
    let malformed = 0;
    for (const e of list as unknown[]) {
      if (isRecord(e) && typeof e['subject'] === 'string' && e['subject'].length > 0 && e['subject'].length <= 255 && typeof e['active'] === 'boolean') entries.push({ subject: e['subject'], active: e['active'] });
      else malformed += 1;
    }
    return { entries, malformed };
  }

  private async links(institutionId: string): Promise<Link[]> {
    const r = await this.d.db.query<{ id: string; idp_subject: string; party_id: string }>('select id, idp_subject, party_id from org.staff_idp_link where institution_id = $1 and unlinked_at is null order by id', [institutionId]);
    return r.rows.map((x) => ({ id: x.id, subject: x.idp_subject, partyId: x.party_id }));
  }

  /** The refusal is an audit row, written once a day per institution so a standing refusal cannot grow the log every cycle. */
  private async recordRefusal(institutionId: string, linked: number, candidates: number, now: Date): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    const seen = await this.d.db.query("select 1 from audit.entry where action = 'institution.staff.drift_refused' and subject = $1 and payload->>'day' = $2", [institutionId, day]);
    if (seen.rowCount > 0) return;
    await this.d.audit.record({ ...SYSTEM, action: 'institution.staff.drift_refused', subject: institutionId, reason: 'Directory drift would remove more than half of the linked staff', payload: { institutionId, day, linked, candidates, reason: 'guard_half' } }, now);
  }

  /** Finishes removals of the last hour whose role or session step failed after the commit; idempotent, skipped for anyone active staff somewhere. */
  private async resume(now: Date, out: DriftResult): Promise<void> {
    const since = new Date(now.getTime() - RESUME_WINDOW_MS);
    const r = await this.d.db.query<{ subject: string; payload: { institutionId?: string; eventId?: string; adminNone?: boolean } }>(
      "select subject, payload from audit.entry where action = 'institution.staff.deprovision' and payload->>'source' = $1 and at > $2 order by seq",
      [SOURCE, since],
    );
    for (const row of r.rows) {
      const { institutionId, eventId } = row.payload;
      if (!institutionId || !eventId) continue;
      try {
        await this.d.deprovision!.finish({ institutionId, partyId: row.subject, eventId, adminNone: row.payload.adminNone === true });
      } catch {
        out.failed += 1;
        this.metrics.put({ 'staff.drift_refused': 1 }, { reason: 'finish_failed' });
      }
    }
  }
}

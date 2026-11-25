// Directory deprovisioning (T-0790, REQ-AUTH-008): a signed WorkOS `dsync.user.deleted` (or `dsync.user.updated` with the user inactive)
// removes the linked staff member from the institution and ends their sessions, within one request. Dark behind `auth.orgSso`.
// - The INSTITUTION comes from the directory id of the event, mapped through the per-organisation configuration; never from the
//   payload's free text. Names, emails and groups in an event are untrusted and are neither logged nor acted on.
// - The staff row is found only through the live link of (that institution, the IdP subject). A stale link whose party now works at
//   another institution never touches that membership: the update is scoped to the event's institution.
// - Row, audit rows and unlink commit together. Role and sessions follow after the commit and are idempotent; a replay of an event
//   whose audit row exists finishes them, so a crash between the steps never leaves a removed person with access.
// - `create` and `update` events never grant or raise anything. The last active admin is removed anyway (the IdP is the authority):
//   an `institution.admin.none` audit row and a notification make that visible.
import { DomainError, guarded, type Metrics } from '@kesher/domain';
import { OrgIdPError, type NotifyPort, type OrgIdPPort, type ScimEvent } from '@kesher/ports';
import { AuditService } from '../audit/service.ts';
import type { TokenService } from '../auth/tokens.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database, SqlClient } from '../db.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import { simulatorVerifier, type Verified, type WebhookVerifier } from '../webhooks/verify.ts';
import { StaffIdpLinks } from './staff-idp-link.ts';
import type { InstitutionTeam } from './team.ts';

export const ORG_SSO_FLAG = 'auth.orgSso';
export const DEPROVISION_PROVIDER = 'workos';
const PROMISE_MS = 15 * 60_000;
const STALE_MS = 5 * 60_000;
const SYSTEM = { actorId: '00000000-0000-7000-8000-000000000000', actorRole: 'system' };
const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });

export interface DirectoryOrg {
  institutionId: string;
  scimBearer: string;
}
export type DirectoryResolver = (directoryId: string | undefined) => DirectoryOrg | undefined;

/** Directory id to institution, from the institution-keyed organisation records. A directory two institutions claim resolves to nothing. */
export function directoryResolver(orgs: Readonly<Record<string, { directoryId?: string | undefined; scimBearer: string }>> = {}): DirectoryResolver {
  const byDirectory = new Map<string, DirectoryOrg | null>();
  for (const [institutionId, o] of Object.entries(orgs)) {
    if (!o.directoryId) continue;
    byDirectory.set(o.directoryId, byDirectory.has(o.directoryId) ? null : { institutionId, scimBearer: o.scimBearer });
  }
  return (directoryId) => (directoryId ? (byDirectory.get(directoryId) ?? undefined) : undefined);
}

export interface StaffDeprovisionDeps {
  db: Database;
  audit: AuditService;
  links: Pick<StaffIdpLinks, 'find'>;
  team: Pick<InstitutionTeam, 'deactivate' | 'clearOrgRole'>;
  tokens: Pick<TokenService, 'revokeAll'>;
  flags: FeatureFlags;
  port: () => OrgIdPPort;
  /** The `org-idp` binding's mode: `sim` takes the simulators' signature header, anything else the adapter's own check. */
  mode: () => string | undefined;
  directories: DirectoryResolver;
  notify: NotifyPort;
  /** Where Kesher staff are told an institution lost its last admin; none configured means the audit row alone. */
  alertTo?: string | undefined;
  metrics: Metrics;
  now: () => Date;
}

interface Done {
  institutionId: string;
  partyId: string;
  eventId: string;
  adminNone: boolean;
}

const lower = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The directory id the event names; read only to look the institution up, never trusted for anything else. */
const directoryIdOf = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  const d = (isRecord(payload['data']) ? payload['data']['directory_id'] : undefined) ?? payload['directoryId'];
  return typeof d === 'string' && d.length <= 200 ? d : undefined;
};

export class StaffDeprovisioner {
  private readonly d: StaffDeprovisionDeps;
  private readonly metrics: Metrics;
  constructor(deps: StaffDeprovisionDeps) {
    this.d = deps;
    this.metrics = guarded(deps.metrics);
  }

  /** Flag off: the route does not exist (404, nothing stored). Otherwise the signature, then the event id. */
  verifier(): WebhookVerifier {
    return {
      verify: async (headers, rawBody, now): Promise<Verified> => {
        if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) throw new DomainError('NOT_FOUND', 'Unknown provider');
        if (this.d.mode() === 'sim') return simulatorVerifier.verify(headers, rawBody, now);
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return { ok: false, eventId: '', payload: undefined, reason: 'malformed json' };
        }
        const id = isRecord(payload) ? (payload['id'] ?? payload['eventId']) : undefined;
        const eventId = typeof id === 'string' ? id : '';
        const header = lower(headers)['workos-signature'];
        if (!header) return { ok: false, eventId, payload, reason: 'missing signature' };
        const port = this.d.port() as { verifyWebhookSignature?: (h: string, raw: string) => boolean };
        let ok: boolean;
        try {
          ok = typeof port.verifyWebhookSignature === 'function' && port.verifyWebhookSignature(header, rawBody);
        } catch {
          ok = false;
        }
        if (ok) return { ok, eventId, payload };
        const t = Number(/t=(\d+)/.exec(header)?.[1]);
        return { ok: false, eventId, payload, reason: Number.isFinite(t) && Math.abs(now.getTime() - t * 1000) > STALE_MS ? 'stale timestamp' : 'bad signature' };
      },
    };
  }

  /** A failure leaves the event pending for replay; every step is idempotent. */
  async process(event: InboundEvent): Promise<void> {
    if (!(await this.d.flags.isOn(ORG_SSO_FLAG))) throw new Error('auth.orgSso is off: the event stays pending');
    const org = this.d.directories(directoryIdOf(event.payload));
    if (!org) return; // an unknown directory moves nothing
    // Anything that is not a user event (a group or directory event, signed and routine) is a clean no-op.
    const kind = isRecord(event.payload) ? event.payload['event'] : undefined;
    if (typeof kind === 'string' && !kind.startsWith('dsync.user.')) return;
    let ev: ScimEvent;
    try {
      ev = await this.d.port().parseScimEvent(org.institutionId, org.scimBearer, event.payload);
    } catch (e) {
      if (e instanceof OrgIdPError && e.code !== 'PROVIDER_UNAVAILABLE') {
        // The adapter refused a signed event (malformed, unknown organisation, another organisation's, a bad bearer). The metric is the
        // signal, labelled by the closed error code only; the event is processed and LEAVES the queue, because a refusal can never
        // succeed on retry and refused events would otherwise starve every provider's replay. Only a transient failure stays pending.
        this.metrics.put({ 'staff.deprovision_refused': 1 }, { reason: e.code.toLowerCase() });
        return;
      }
      throw e;
    }
    if (!(ev.op === 'deactivate' || (ev.op === 'update' && !ev.active))) return; // create and update never grant or raise
    const now = this.d.now();
    const lagMs = now.getTime() - Date.parse(ev.occurredAt);
    if (lagMs > PROMISE_MS) this.metrics.put({ 'staff.deprovision_lag_s': lagMs / 1000 });

    const prior = await this.prior(event.eventId, org.institutionId);
    if (prior) return this.finish(prior);
    const partyId = await this.d.links.find(org.institutionId, ev.subject);
    if (!partyId) return;
    const done = await this.deprovision(org.institutionId, ev.subject, event.eventId, now);
    if (done) return this.finish(done);
    // The link was gone inside the transaction: a concurrent delivery of this same event committed first. If its post-commit steps
    // failed, the router would mark THIS delivery processed and nobody would retry, so finish what that delivery committed.
    const raced = await this.prior(event.eventId, org.institutionId);
    if (raced) await this.finish(raced);
  }

  /** Row, audit and unlink in one transaction: a crash leaves all of it or none. */
  private async deprovision(institutionId: string, subject: string, eventId: string, now: Date): Promise<Done | undefined> {
    return this.d.db.transaction(async (tx) => {
      const txdb = inTx(tx);
      const link = (await tx.query<{ party_id: string; linked_at: string | Date }>('select party_id, linked_at from org.staff_idp_link where institution_id = $1 and idp_subject = $2 and unlinked_at is null for update', [institutionId, subject])).rows[0];
      if (!link) return undefined;
      const member = (await tx.query<{ role: string }>('select role from org.staff where party_id = $1 and institution_id = $2 and active for update', [link.party_id, institutionId])).rows[0];
      const removed = member ? await this.d.team.deactivate(institutionId, link.party_id, txdb) : false;
      const adminNone = removed && member?.role === 'admin' && (await tx.query("select 1 from org.staff where institution_id = $1 and active and role = 'admin'", [institutionId])).rowCount === 0;
      await this.d.audit.record({ ...SYSTEM, action: 'institution.staff.deprovision', subject: link.party_id, reason: `Directory event ${eventId}`, payload: { institutionId, eventId, removed, adminNone } }, now, txdb);
      if (adminNone) await this.d.audit.record({ ...SYSTEM, action: 'institution.admin.none', subject: institutionId, reason: `Directory event ${eventId} removed the last active admin`, payload: { institutionId, eventId } }, now, txdb);
      // The unlink clock must not precede the link's own (a check on the table): never earlier than linked_at.
      const at = new Date(Math.max(now.getTime(), new Date(link.linked_at).getTime()));
      await new StaffIdpLinks({ db: txdb, audit: new AuditService(txdb) }).unlink(institutionId, subject, SYSTEM, at);
      return { institutionId, partyId: link.party_id, eventId, adminNone };
    });
  }

  /** What an earlier pass of this event committed, if it did. */
  private async prior(eventId: string, institutionId: string): Promise<Done | undefined> {
    const r = await this.d.db.query<{ subject: string; payload: { adminNone?: boolean } }>(`select subject, payload from audit.entry where action = 'institution.staff.deprovision' and payload->>'eventId' = $1 and payload->>'institutionId' = $2`, [eventId, institutionId]);
    const row = r.rows[0];
    return row ? { institutionId, partyId: row.subject, eventId, adminNone: row.payload.adminNone === true } : undefined;
  }

  /**
   * After the commit: role, sessions, alert. Idempotent; a throw leaves the event unprocessed so the replay retries it. The check and the
   * role strip are two steps (the role lives in the identity repository, not in SQL): a hire between them is possible only in that
   * instant, and the new institution's grant (`InstitutionTeam.apply`) writes the role again. Skipped for a party who is active staff anywhere (a stale link must not reach their new job). */
  private async finish(done: Done): Promise<void> {
    const active = await this.d.db.query('select 1 from org.staff where party_id = $1 and active', [done.partyId]);
    if (!active.rowCount) {
      await this.d.team.clearOrgRole(done.partyId);
      await this.d.tokens.revokeAll(done.partyId, 'idp_deprovision');
    }
    if (done.adminNone && this.d.alertTo) {
      await this.d.notify.send({ channel: 'email', to: this.d.alertTo, template: 'institution.admin_none', locale: 'en', data: { institutionId: done.institutionId }, category: 'service' }, `deprovision:${done.eventId}:admin-none`);
    }
  }
}

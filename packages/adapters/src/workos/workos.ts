// WorkOS adapter (T-0118, ADR-004): OrgIdPPort for institution staff SSO (WorkOS SSO, SAML or OIDC
// behind one connection per organisation) and deprovisioning (WorkOS Directory Sync webhooks).
// No SDK: REST through an injected fetch. Flag: auth.orgSso. REQ-AUTH-008.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fixedClock, OrgIdPError, type Clock, type OrgIdentity, type OrgIdPPort, type OrgSsoStart, type ScimEvent, type ScimOp } from '@kesher/ports';

export interface WorkOsOrganisation {
  /** WorkOS organisation id (org_…), the SSO connection's owner. */
  workosOrganizationId: string;
  /** WorkOS directory id (directory_…) for Directory Sync; optional until SCIM is connected. */
  directoryId?: string | undefined;
  /** Bearer our inbound webhook route expects for this organisation's SCIM events. */
  scimBearer: string;
}

export interface WorkOsOptions {
  clientId: string;
  /** API key (sk_…); used as the bearer for the token exchange and directory reads. */
  apiKey: string;
  /** Our organisation id → WorkOS ids. Unknown organisations are refused before any network call. */
  orgs: Readonly<Record<string, WorkOsOrganisation>>;
  /** Webhook signing secret for `verifyWebhookSignature`. */
  webhookSecret?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  clock?: Clock | undefined;
  /** How long an issued SSO state is accepted. */
  stateTtlMs?: number | undefined;
}

interface WorkOsProfile {
  id: string;
  idp_id: string;
  organization_id?: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  groups?: string[] | null;
}

interface WorkOsDirectoryUser {
  id: string;
  idp_id: string;
  organization_id?: string;
  emails?: { primary?: boolean; value: string }[];
  state: 'active' | 'inactive';
  first_name?: string | null;
  last_name?: string | null;
}

/** A WorkOS Directory Sync webhook envelope. */
export interface WorkOsDsyncEvent {
  id: string;
  event: 'dsync.user.created' | 'dsync.user.updated' | 'dsync.user.deleted';
  data: WorkOsDirectoryUser;
  created_at?: string;
}

const DSYNC_OP: Record<WorkOsDsyncEvent['event'], ScimOp> = { 'dsync.user.created': 'create', 'dsync.user.updated': 'update', 'dsync.user.deleted': 'deactivate' };
const PORT_OPS: ReadonlySet<string> = new Set<ScimOp>(['create', 'update', 'deactivate']);
const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

const primaryEmail = (u: WorkOsDirectoryUser): string | undefined => (u.emails?.find((e) => e.primary) ?? u.emails?.[0])?.value;
const displayName = (first: string | null | undefined, last: string | null | undefined, email: string): string => [first, last].filter(Boolean).join(' ') || email.split('@')[0]!;

export class WorkOsOrgIdPAdapter implements OrgIdPPort {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly clock: Clock;
  private readonly stateTtl: number;
  private readonly states = new Map<string, { orgId: string; issuedAt: number }>();
  /** Deactivations learned from webhooks, keyed `${orgId}:${subject}`; refuses SSO before the next directory read. */
  private readonly deactivated = new Set<string>();
  private readonly seenEvents = new Map<string, ScimEvent>();

  private readonly opts: WorkOsOptions;
  constructor(opts: WorkOsOptions) {
    this.opts = opts;
    if (!opts.clientId || !opts.apiKey) throw new Error('WorkOS adapter needs clientId and apiKey');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.base = (opts.baseUrl ?? 'https://api.workos.com').replace(/\/$/, '');
    this.clock = opts.clock ?? fixedClock();
    this.stateTtl = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  }

  async startSso(orgId: string, input: { state: string; redirectUri: string }): Promise<OrgSsoStart> {
    const org = this.org(orgId);
    // WorkOS reports an unreachable or misconfigured connection at the authorize step; probe it so the
    // console can show "unavailable" instead of bouncing the admin through the IdP.
    await this.probeConnection(org);
    const q = new URLSearchParams({ response_type: 'code', client_id: this.opts.clientId, redirect_uri: input.redirectUri, state: input.state, organization: org.workosOrganizationId });
    this.states.set(input.state, { orgId, issuedAt: this.clock.now().getTime() });
    return { url: `${this.base}/sso/authorize?${q.toString()}`, state: input.state };
  }

  async handleCallback(input: { code: string; state: string }): Promise<OrgIdentity> {
    const pending = this.states.get(input.state);
    if (!pending) throw new OrgIdPError('STATE_MISMATCH', 'Unknown or already used state');
    this.states.delete(input.state);
    if (this.clock.now().getTime() - pending.issuedAt > this.stateTtl) throw new OrgIdPError('STATE_MISMATCH', 'State expired');
    const org = this.org(pending.orgId);
    const res = await this.call('POST', '/sso/token', new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.opts.apiKey, grant_type: 'authorization_code', code: input.code }));
    if (res.status === 400 || res.status === 401) throw new OrgIdPError('INVALID_CODE', 'WorkOS rejected the authorization code');
    const json = (await this.json(res)) as { profile?: WorkOsProfile };
    const p = json.profile;
    if (!p || typeof p.idp_id !== 'string' || typeof p.email !== 'string') throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS profile incomplete');
    // Fail secure: a profile from another organisation's connection never signs into this one.
    if (p.organization_id && p.organization_id !== org.workosOrganizationId) throw new OrgIdPError('STATE_MISMATCH', 'Profile belongs to another organisation');
    if (this.deactivated.has(`${pending.orgId}:${p.idp_id}`)) throw new OrgIdPError('INVALID_CODE', 'User deprovisioned');
    return { orgId: pending.orgId, subject: p.idp_id, email: p.email, displayName: displayName(p.first_name, p.last_name, p.email), groups: Array.isArray(p.groups) ? p.groups.filter((g): g is string => typeof g === 'string') : [] };
  }

  async parseScimEvent(orgId: string, bearer: string, body: unknown): Promise<ScimEvent> {
    const org = this.org(orgId);
    if (!safeEqual(bearer, org.scimBearer)) throw new OrgIdPError('SCIM_UNAUTHORIZED', 'Bad SCIM bearer');
    const n = normaliseEvent(body);
    if (!n) throw new OrgIdPError('SCIM_MALFORMED', 'SCIM event missing fields');
    if (n.workosOrganizationId && n.workosOrganizationId !== org.workosOrganizationId) throw new OrgIdPError('SCIM_UNAUTHORIZED', 'Event belongs to another organisation');
    const key = `${orgId}:${n.eventId}`;
    const prior = this.seenEvents.get(key);
    if (prior) return prior;
    const event: ScimEvent = { orgId, op: n.op, subject: n.subject, email: n.email, active: n.active, occurredAt: n.occurredAt ?? this.clock.now().toISOString(), eventId: n.eventId };
    if (event.active) this.deactivated.delete(`${orgId}:${event.subject}`);
    else this.deactivated.add(`${orgId}:${event.subject}`);
    this.seenEvents.set(key, event);
    return event;
  }

  async listDirectory(orgId: string): Promise<readonly { subject: string; email: string; active: boolean }[]> {
    const org = this.org(orgId);
    if (!org.directoryId) return [...this.deactivated].filter((k) => k.startsWith(`${orgId}:`)).map((k) => ({ subject: k.slice(orgId.length + 1), email: '', active: false }));
    const out = new Map<string, { subject: string; email: string; active: boolean }>();
    let after: string | undefined;
    do {
      const q = new URLSearchParams({ directory: org.directoryId, limit: '100', ...(after ? { after } : {}) });
      const res = await this.call('GET', `/directory_users?${q.toString()}`);
      const page = (await this.json(res)) as { data?: WorkOsDirectoryUser[]; list_metadata?: { after?: string | null } };
      for (const u of page.data ?? []) {
        if (typeof u.idp_id !== 'string') continue;
        const active = u.state === 'active' && !this.deactivated.has(`${orgId}:${u.idp_id}`);
        out.set(u.idp_id, { subject: u.idp_id, email: primaryEmail(u) ?? '', active });
      }
      after = page.list_metadata?.after ?? undefined;
    } while (after);
    // Deactivations we learned from webhooks that the directory has not caught up with yet.
    for (const k of this.deactivated) {
      if (!k.startsWith(`${orgId}:`)) continue;
      const subject = k.slice(orgId.length + 1);
      if (!out.has(subject)) out.set(subject, { subject, email: '', active: false });
    }
    return [...out.values()];
  }

  /**
   * Verifies a `WorkOS-Signature: t=<unix>, v1=<hex>` header over `${t}.${rawBody}` with the webhook
   * secret, within a 5-minute tolerance. The inbound webhook route calls this before storing the event.
   */
  verifyWebhookSignature(signatureHeader: string, rawBody: string): boolean {
    const secret = this.opts.webhookSecret;
    if (!secret) return false;
    const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.trim().split('=') as [string, string]));
    const t = Number(parts['t']);
    const v1 = parts['v1'];
    if (!Number.isFinite(t) || !v1) return false;
    if (Math.abs(this.clock.now().getTime() - t * 1000) > SIGNATURE_TOLERANCE_MS) return false;
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return safeEqual(expected, v1);
  }

  private org(orgId: string): WorkOsOrganisation {
    const org = this.opts.orgs[orgId];
    if (!org) throw new OrgIdPError('UNKNOWN_ORG', `No WorkOS organisation for ${orgId}`);
    return org;
  }

  private async probeConnection(org: WorkOsOrganisation): Promise<void> {
    const res = await this.call('GET', `/connections?organization_id=${encodeURIComponent(org.workosOrganizationId)}&limit=1`);
    const page = (await this.json(res)) as { data?: { state?: string }[] };
    const c = page.data?.[0];
    if (!c) throw new OrgIdPError('UNKNOWN_ORG', 'No SSO connection configured in WorkOS for this organisation');
    if (c.state !== 'active') throw new OrgIdPError('PROVIDER_UNAVAILABLE', `SSO connection is ${c.state ?? 'inactive'}`);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body: body.toString() } : {}) });
    } catch {
      throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS unreachable');
    }
    if (res.status === 429 || res.status >= 500) throw new OrgIdPError('PROVIDER_UNAVAILABLE', `WorkOS returned ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      // Our API key, not the user's code: surface as an outage so nobody sees a login hint.
      if (method === 'GET') throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS credentials rejected');
    }
    return res;
  }

  private async json(res: Response): Promise<unknown> {
    if (!res.ok) throw new OrgIdPError('PROVIDER_UNAVAILABLE', `WorkOS returned ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS returned a non-JSON body');
    }
  }
}

interface Normalised {
  eventId: string;
  op: ScimOp;
  subject: string;
  email: string;
  active: boolean;
  occurredAt?: string | undefined;
  workosOrganizationId?: string | undefined;
}

/** Accepts a WorkOS `dsync.user.*` envelope or the port's own event shape (used by relays and tests). */
export function normaliseEvent(body: unknown): Normalised | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b['event'] === 'string' && (b['event'] as string).startsWith('dsync.user.')) {
    const e = b as unknown as WorkOsDsyncEvent;
    const op = DSYNC_OP[e.event];
    const u = e.data;
    if (!op || typeof e.id !== 'string' || !u || typeof u.idp_id !== 'string') return undefined;
    const email = primaryEmail(u);
    if (!email) return undefined;
    const active = op !== 'deactivate' && u.state === 'active';
    return { eventId: e.id, op, subject: u.idp_id, email, active, occurredAt: typeof e.created_at === 'string' ? e.created_at : undefined, workosOrganizationId: typeof u.organization_id === 'string' ? u.organization_id : undefined };
  }
  const op = b['op'];
  if (typeof b['eventId'] !== 'string' || typeof b['subject'] !== 'string' || typeof b['email'] !== 'string' || typeof op !== 'string' || !PORT_OPS.has(op)) return undefined;
  const typedOp = op as ScimOp;
  return { eventId: b['eventId'], op: typedOp, subject: b['subject'], email: b['email'], active: typeof b['active'] === 'boolean' ? b['active'] && typedOp !== 'deactivate' : typedOp !== 'deactivate', occurredAt: typeof b['occurredAt'] === 'string' ? b['occurredAt'] : undefined };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

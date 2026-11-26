// WorkOS adapter (T-0118, ADR-004): OrgIdPPort for institution staff SSO (WorkOS SSO, SAML or OIDC
// behind one connection per organisation) and deprovisioning (WorkOS Directory Sync webhooks).
// No SDK: REST through an injected fetch. Flag: auth.orgSso. REQ-AUTH-008.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fixedClock, OrgIdPError, parseWebhookSignature, webhookTimestampFresh, type Clock, type DirectoryUser, type OrgIdentity, type OrgIdPPort, type OrgSsoStart, type ScimEvent, type ScimOp } from '@kesher/ports';

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
  /** Per-request budget for every WorkOS call, a directory page included; a hung call is a failed read. Default 10 s. */
  requestTimeoutMs?: number | undefined;
  /**
   * Where the SSO states, the deactivations learned from webhooks and the seen event ids live. Default: an in-process store, which is only
   * correct for ONE API process (see `WorkOsStateStore`). With more than one process, inject a shared store.
   */
  store?: WorkOsStateStore | undefined;
}

export interface PendingSsoState {
  orgId: string;
  issuedAt: number;
}

/**
 * State the adapter must share between API processes (T-1116 item 5, a GATE on `auth.orgSso`): with the default in-process store a callback
 * that lands on a process other than the one that started the sign-in answers STATE_MISMATCH, and a deactivation learned by one process is
 * unknown to the next. A multi-instance deployment MUST inject an implementation backed by a shared store (Postgres; no vendor SDK). It is
 * not built here (it needs the production wiring of T-1118 and a decision on tables); the contract it must keep:
 * - `takeState` is atomic and single-use: of two concurrent takes of one state, exactly one gets the record.
 * - deactivations are never evicted or expired by the store: forgetting one re-admits a removed person.
 */
export interface WorkOsStateStore {
  putState(state: string, record: PendingSsoState, ttlMs: number): Promise<void>;
  takeState(state: string): Promise<PendingSsoState | undefined>;
  markDeactivated(orgId: string, subject: string): Promise<void>;
  clearDeactivated(orgId: string, subject: string): Promise<void>;
  isDeactivated(orgId: string, subject: string): Promise<boolean>;
  listDeactivated(orgId: string): Promise<readonly string[]>;
  getEvent(orgId: string, eventId: string): Promise<ScimEvent | undefined>;
  putEvent(orgId: string, eventId: string, event: ScimEvent): Promise<void>;
}

/** Bounds of the in-process store: unauthenticated starts cannot grow it without limit (oldest first out). */
export const MAX_PENDING_SSO_STATES = 2_000;
export const MAX_SEEN_EVENTS = 10_000;

/** The default store: per-process memory with a TTL sweep and a size cap on states and seen events. Deactivations are kept, never evicted. */
export class InMemoryWorkOsStateStore implements WorkOsStateStore {
  private readonly states = new Map<string, PendingSsoState & { expiresAt: number }>();
  private readonly deactivated = new Map<string, Set<string>>();
  private readonly events = new Map<string, ScimEvent>();

  /** Pending SSO states held (for tests and metrics). */
  get size(): number {
    return this.states.size;
  }

  async putState(state: string, record: PendingSsoState, ttlMs: number): Promise<void> {
    for (const [k, v] of this.states) {
      if (v.expiresAt > record.issuedAt) break; // insertion order is issue order: the rest are younger
      this.states.delete(k);
    }
    this.states.delete(state);
    this.states.set(state, { ...record, expiresAt: record.issuedAt + ttlMs });
    while (this.states.size > MAX_PENDING_SSO_STATES) this.states.delete(this.states.keys().next().value as string);
  }

  async takeState(state: string): Promise<PendingSsoState | undefined> {
    const v = this.states.get(state);
    if (!v) return undefined;
    this.states.delete(state);
    return { orgId: v.orgId, issuedAt: v.issuedAt };
  }

  async markDeactivated(orgId: string, subject: string): Promise<void> {
    const set = this.deactivated.get(orgId) ?? new Set<string>();
    set.add(subject);
    this.deactivated.set(orgId, set);
  }

  async clearDeactivated(orgId: string, subject: string): Promise<void> {
    this.deactivated.get(orgId)?.delete(subject);
  }

  async isDeactivated(orgId: string, subject: string): Promise<boolean> {
    return this.deactivated.get(orgId)?.has(subject) ?? false;
  }

  async listDeactivated(orgId: string): Promise<readonly string[]> {
    return [...(this.deactivated.get(orgId) ?? [])];
  }

  async getEvent(orgId: string, eventId: string): Promise<ScimEvent | undefined> {
    return this.events.get(`${orgId}:${eventId}`);
  }

  async putEvent(orgId: string, eventId: string, event: ScimEvent): Promise<void> {
    this.events.set(`${orgId}:${eventId}`, event);
    while (this.events.size > MAX_SEEN_EVENTS) this.events.delete(this.events.keys().next().value as string); // a dropped id only costs a replayed (idempotent) parse
  }
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
  emails?: { primary?: boolean; value: string }[] | null;
  /** WorkOS documents `active` and `inactive`; anything else (or nothing) is read as suspect, never as inactive. */
  state?: string;
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
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Directory pages read per listing (100 users each); past it the read FAILS rather than answering a short list. */
export const MAX_DIRECTORY_PAGES = 100;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The primary email (else the first), tolerating a missing, null or malformed `emails`: a removal never needs it. */
const primaryEmail = (u: WorkOsDirectoryUser): string | undefined => {
  if (!Array.isArray(u.emails)) return undefined;
  const mails = (u.emails as unknown[]).filter((e): e is { primary?: boolean; value: string } => isRecord(e) && typeof e['value'] === 'string' && e['value'].length > 0);
  return (mails.find((e) => e.primary === true) ?? mails[0])?.value;
};
const displayName = (first: string | null | undefined, last: string | null | undefined, email: string): string => [first, last].filter(Boolean).join(' ') || email.split('@')[0]!;

export class WorkOsOrgIdPAdapter implements OrgIdPPort {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly clock: Clock;
  private readonly stateTtl: number;
  private readonly timeoutMs: number;
  /** SSO states, deactivations learned from webhooks (they refuse SSO before the next directory read) and seen event ids. */
  private readonly store: WorkOsStateStore;

  private readonly opts: WorkOsOptions;
  constructor(opts: WorkOsOptions) {
    this.opts = opts;
    if (!opts.clientId || !opts.apiKey) throw new Error('WorkOS adapter needs clientId and apiKey');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.base = (opts.baseUrl ?? 'https://api.workos.com').replace(/\/$/, '');
    this.clock = opts.clock ?? fixedClock();
    this.stateTtl = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.store = opts.store ?? new InMemoryWorkOsStateStore();
  }

  async startSso(orgId: string, input: { state: string; redirectUri: string }): Promise<OrgSsoStart> {
    const org = this.org(orgId);
    // WorkOS reports an unreachable or misconfigured connection at the authorize step; probe it so the
    // console can show "unavailable" instead of bouncing the admin through the IdP.
    await this.probeConnection(org);
    const q = new URLSearchParams({ response_type: 'code', client_id: this.opts.clientId, redirect_uri: input.redirectUri, state: input.state, organization: org.workosOrganizationId });
    await this.store.putState(input.state, { orgId, issuedAt: this.clock.now().getTime() }, this.stateTtl);
    return { url: `${this.base}/sso/authorize?${q.toString()}`, state: input.state };
  }

  async handleCallback(input: { code: string; state: string }): Promise<OrgIdentity> {
    const pending = await this.store.takeState(input.state);
    if (!pending) throw new OrgIdPError('STATE_MISMATCH', 'Unknown or already used state');
    if (this.clock.now().getTime() - pending.issuedAt > this.stateTtl) throw new OrgIdPError('STATE_MISMATCH', 'State expired');
    const org = this.org(pending.orgId);
    const res = await this.call('POST', '/sso/token', new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.opts.apiKey, grant_type: 'authorization_code', code: input.code }));
    if (res.status === 400 || res.status === 401) throw new OrgIdPError('INVALID_CODE', 'WorkOS rejected the authorization code');
    const json = (await this.json(res)) as { profile?: WorkOsProfile };
    const p = json.profile;
    if (!p || typeof p.idp_id !== 'string' || typeof p.email !== 'string') throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS profile incomplete');
    // Fail secure: a profile from another organisation's connection never signs into this one.
    if (p.organization_id && p.organization_id !== org.workosOrganizationId) throw new OrgIdPError('STATE_MISMATCH', 'Profile belongs to another organisation');
    if (await this.store.isDeactivated(pending.orgId, p.idp_id)) throw new OrgIdPError('INVALID_CODE', 'User deprovisioned');
    return { orgId: pending.orgId, subject: p.idp_id, email: p.email, displayName: displayName(p.first_name, p.last_name, p.email), groups: Array.isArray(p.groups) ? p.groups.filter((g): g is string => typeof g === 'string') : [] };
  }

  async parseScimEvent(orgId: string, bearer: string, body: unknown): Promise<ScimEvent> {
    const org = this.org(orgId);
    if (!safeEqual(bearer, org.scimBearer)) throw new OrgIdPError('SCIM_UNAUTHORIZED', 'Bad SCIM bearer');
    const n = normaliseEvent(body);
    if (!n) throw new OrgIdPError('SCIM_MALFORMED', 'SCIM event missing fields');
    if (n.workosOrganizationId && n.workosOrganizationId !== org.workosOrganizationId) throw new OrgIdPError('SCIM_UNAUTHORIZED', 'Event belongs to another organisation');
    const prior = await this.store.getEvent(orgId, n.eventId);
    if (prior) return prior;
    const event: ScimEvent = { orgId, op: n.op, subject: n.subject, email: n.email, active: n.active, occurredAt: n.occurredAt ?? this.clock.now().toISOString(), eventId: n.eventId };
    if (event.active) await this.store.clearDeactivated(orgId, event.subject);
    else await this.store.markDeactivated(orgId, event.subject);
    await this.store.putEvent(orgId, n.eventId, event);
    return event;
  }

  async listDirectory(orgId: string): Promise<readonly DirectoryUser[]> {
    const org = this.org(orgId);
    const learned = await this.store.listDeactivated(orgId);
    if (!org.directoryId) return learned.map((subject) => ({ subject, email: '', active: false, rawState: 'inactive' }));
    const out = new Map<string, DirectoryUser>();
    const unusable: DirectoryUser[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_DIRECTORY_PAGES) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS directory has more pages than the read allows');
      const q = new URLSearchParams({ directory: org.directoryId, limit: '100', ...(after ? { after } : {}) });
      const page = await this.json(await this.call('GET', `/directory_users?${q.toString()}`));
      // A failed or odd page is a failed read, never an empty one: a short list would make linked users on later pages look absent.
      if (!isRecord(page) || !Array.isArray(page['data'])) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS directory page has no data');
      const meta = page['list_metadata'];
      const next = isRecord(meta) ? meta['after'] : undefined;
      if (next !== null && (typeof next !== 'string' || next === '')) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS directory page has a bad cursor');
      for (const raw of page['data'] as unknown[]) {
        if (!isRecord(raw) || typeof raw['idp_id'] !== 'string') {
          unusable.push({ subject: '', email: '', active: false }); // the sweep counts it as malformed and stops trusting absence
          continue;
        }
        const u = raw as unknown as WorkOsDirectoryUser;
        const rawState = typeof u.state === 'string' ? u.state : undefined;
        const learnedInactive = learned.includes(u.idp_id);
        const entry: DirectoryUser = { subject: u.idp_id, email: primaryEmail(u) ?? '', active: rawState === 'active' && !learnedInactive, rawState: learnedInactive ? 'inactive' : rawState };
        const prior = out.get(u.idp_id);
        // Listed twice: in doubt, the active entry wins.
        if (!prior || !prior.active) out.set(u.idp_id, entry);
      }
      if (next === null) break;
      if (seenCursors.has(next)) throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS directory cursor repeats');
      seenCursors.add(next);
      after = next;
    }
    // Deactivations we learned from webhooks that the directory has not caught up with yet.
    for (const subject of learned) if (!out.has(subject)) out.set(subject, { subject, email: '', active: false, rawState: 'inactive' });
    return [...out.values(), ...unusable];
  }

  /**
   * Verifies `WorkOS-Signature: t=<ms since the Unix epoch>, v1=<hex>[, v1=<hex>]` (T-1116; unit per the owner-provided WorkOS docs, to be
   * confirmed against a real staging delivery): `v1` is the hex HMAC-SHA256 of `${t}.${raw body}` keyed by the webhook secret, and `t` must
   * be within 5 minutes of now on either side. A `t` in seconds is a 1970 date and is refused, not converted. The inbound webhook route
   * calls this with the RAW body text before anything is stored.
   */
  verifyWebhookSignature(signatureHeader: string, rawBody: string): boolean {
    const secret = this.opts.webhookSecret;
    if (!secret || typeof rawBody !== 'string') return false;
    const sig = parseWebhookSignature(signatureHeader);
    if (!sig || !webhookTimestampFresh(sig.tMs, this.clock.now().getTime())) return false;
    const expected = createHmac('sha256', secret).update(`${sig.t}.${rawBody}`).digest('hex');
    let ok = false;
    for (const candidate of sig.v1) ok = safeEqual(expected, candidate) || ok; // every candidate is compared, in constant time each
    return ok;
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
      res = await this.bounded((signal) => this.fetchImpl(`${this.base}${path}`, { method, signal, headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body: body.toString() } : {}) }));
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

  /** Runs one request within the budget: the abort signal is passed on, and a stub that ignores it is still cut off by the race. */
  private async bounded<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new OrgIdPError('PROVIDER_UNAVAILABLE', 'WorkOS timed out'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([run(ac.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async json(res: Response): Promise<unknown> {
    if (!res.ok) throw new OrgIdPError('PROVIDER_UNAVAILABLE', `WorkOS returned ${res.status}`);
    try {
      return await this.bounded(() => res.json());
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
    if (!op || typeof e.id !== 'string' || !u || typeof u.idp_id !== 'string' || u.idp_id.length === 0) return undefined;
    const email = primaryEmail(u);
    // Deactivation and deletion need only the subject (idp id), the event id and the directory: a removal never waits for an email. An
    // `updated` must say `active` or `inactive` outright (anything else is malformed, never read as a removal); creation needs the email.
    if (op === 'update' && u.state !== 'active' && u.state !== 'inactive') return undefined;
    const active = op === 'create' ? u.state === 'active' : op === 'update' && u.state === 'active';
    if ((op === 'create' || active) && !email) return undefined;
    return { eventId: e.id, op, subject: u.idp_id, email: email ?? '', active, occurredAt: typeof e.created_at === 'string' ? e.created_at : undefined, workosOrganizationId: typeof u.organization_id === 'string' ? u.organization_id : undefined };
  }
  const op = b['op'];
  if (typeof b['eventId'] !== 'string' || typeof b['subject'] !== 'string' || typeof op !== 'string' || !PORT_OPS.has(op)) return undefined;
  const typedOp = op as ScimOp;
  if (typeof b['email'] !== 'string' && typedOp !== 'deactivate') return undefined;
  return { eventId: b['eventId'], op: typedOp, subject: b['subject'], email: typeof b['email'] === 'string' ? b['email'] : '', active: typeof b['active'] === 'boolean' ? b['active'] && typedOp !== 'deactivate' : typedOp !== 'deactivate', occurredAt: typeof b['occurredAt'] === 'string' ? b['occurredAt'] : undefined };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

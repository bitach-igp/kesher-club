// The member's consent (T-1015, REQ-AGT-010, REQ-AGT-008, ADR-009). The consent screen (T-1017) reads a stored
// authorization request (T-1014) and the member decides:
// - approve, after a fresh passkey step-up, with the scopes they kept (a subset of those asked). That creates the
//   grant, or replaces the scopes of their active grant for that client, so the grants screen shows one row per
//   assistant. It answers the client's redirect URI with a one-time code, valid 60 seconds and stored only as a
//   hash, plus the state and the issuer (RFC 9207).
// - deny, which answers the redirect URI with access_denied.
// The first member to open a request claims it, so a forwarded link is not someone else's to approve. A request
// is decided once: a second tap finds it decided.
import { createHash, randomBytes } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import { SCOPES, type ScopeTier } from '@kesher/ports';
import type { AuditService } from '../audit/service.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import { MCP_FLAG, type OAuthConfig } from './authorize.ts';

export const CODE_TTL_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const codeHash = (code: string): Buffer => createHash('sha256').update(code).digest();

export interface ConsentView {
  id: string;
  /** The client's own words from its metadata document: shown as text. */
  client: { id: string; name: string; uri?: string };
  scopes: { scope: string; tier: ScopeTier }[];
  expiresAt: string;
}

interface RequestRow {
  id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uri: string;
  scopes: string[];
  state: string;
  status: string;
  party_id: string | null;
  expires_at: string | Date;
}

export class ConsentService {
  private readonly db: Database;
  private readonly audit: AuditService;
  private readonly cfg: Pick<OAuthConfig, 'issuer'>;
  constructor(db: Database, audit: AuditService, cfg: Pick<OAuthConfig, 'issuer'>) {
    this.db = db;
    this.audit = audit;
    this.cfg = cfg;
  }

  async view(id: string, partyId: string, now: Date): Promise<ConsentView> {
    const r = await this.open(id, partyId, now);
    return { id: r.id, client: { id: r.client_id, name: r.client_name, ...(r.client_uri ? { uri: r.client_uri } : {}) }, scopes: r.scopes.map((scope) => ({ scope, tier: SCOPES[scope]! })), expiresAt: new Date(r.expires_at).toISOString() };
  }

  async approve(id: string, partyId: string, kept: unknown, now: Date): Promise<{ redirect: string }> {
    const r = await this.open(id, partyId, now);
    const scopes = Array.isArray(kept) ? [...new Set(kept.filter((s): s is string => typeof s === 'string'))] : [];
    if (!scopes.length || !scopes.every((s) => r.scopes.includes(s))) throw new DomainError('VALIDATION_FAILED', 'Keep one or more of the scopes the assistant asked for', { asked: r.scopes });
    const code = randomBytes(32).toString('base64url');
    const grantId = await this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(`select id from agent.grant where party_id = $1 and client_id = $2 and status = 'active' order by created_at desc limit 1 for update`, [partyId, r.client_id]);
      const gid = existing.rows[0]?.id ?? uuidv7(now);
      if (existing.rows[0]) await tx.query('update agent.grant set scopes = $2 where id = $1', [gid, scopes]);
      else await tx.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, $2, $3, $4, 'active', $5)`, [gid, r.client_id, partyId, scopes, now]);
      const done = await tx.query(
        `update agent.authorization_request set status = 'approved', party_id = $2, grant_id = $3, scopes = $4, code_hash = $5, code_expires_at = $6, decided_at = $7
          where id = $1 and status = 'pending' and expires_at > $7`,
        [id, partyId, gid, scopes, codeHash(code), new Date(now.getTime() + CODE_TTL_MS), now],
      );
      if (!done.rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request was already decided');
      return gid;
    });
    await this.audit.record({ actorId: partyId, actorRole: 'member', action: 'agent.grant.approve', subject: partyId, reason: r.client_name, payload: { grantId, clientId: r.client_id, scopes } }, now);
    return { redirect: this.back(r, { code }) };
  }

  async deny(id: string, partyId: string, now: Date): Promise<{ redirect: string }> {
    const r = await this.open(id, partyId, now);
    const done = await this.db.query(`update agent.authorization_request set status = 'denied', party_id = $2, decided_at = $3 where id = $1 and status = 'pending'`, [id, partyId, now]);
    if (!done.rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request was already decided');
    return { redirect: this.back(r, { error: 'access_denied' }) };
  }

  /** A pending, unexpired request this member may decide; the first member to open it claims it. */
  private async open(id: string, partyId: string, now: Date): Promise<RequestRow> {
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 'No such request');
    await this.db.query(`update agent.authorization_request set party_id = $2 where id = $1 and party_id is null and status = 'pending'`, [id, partyId]);
    const r = (
      await this.db.query<RequestRow>(
        `select r.id, r.client_id, c.name as client_name, c.metadata->>'client_uri' as client_uri, r.redirect_uri, r.scopes, r.state, r.status, r.party_id, r.expires_at
           from agent.authorization_request r join agent.client c on c.client_id = r.client_id where r.id = $1`,
        [id],
      )
    ).rows[0];
    if (!r || r.party_id !== partyId) throw new DomainError('NOT_FOUND', 'No such request');
    if (r.status !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request was already decided');
    if (new Date(r.expires_at) <= now) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request has expired; ask the assistant to start again');
    return r;
  }

  private back(r: RequestRow, add: Record<string, string>): string {
    const u = new URL(r.redirect_uri);
    for (const [k, v] of Object.entries(add)) u.searchParams.set(k, v);
    u.searchParams.set('state', r.state);
    u.searchParams.set('iss', this.cfg.issuer.replace(/\/$/, ''));
    return u.href;
  }
}

/** The member app's three calls, under the member's bearer and `mcp.enabled`; approving needs a fresh step-up. */
export function consentHandlers(d: { consent: ConsentService; stepUp: StepUpService; flags: FeatureFlags }): Record<'getAgentConsent' | 'approveAgentConsent' | 'denyAgentConsent', Handler> {
  const gate = async () => {
    if (!(await d.flags.isOn(MCP_FLAG))) throw new DomainError('FEATURE_OFF', 'Assistant access is not enabled');
  };
  return {
    getAgentConsent: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      return ok(await d.consent.view(req.params['id'] ?? '', p.partyId, req.now));
    }),
    approveAgentConsent: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      requireStepUp(d.stepUp, req);
      const b = (req.body ?? {}) as { scopes?: unknown };
      return ok(await d.consent.approve(req.params['id'] ?? '', p.partyId, b.scopes, req.now));
    }),
    denyAgentConsent: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      return ok(await d.consent.deny(req.params['id'] ?? '', p.partyId, req.now));
    }),
  };
}

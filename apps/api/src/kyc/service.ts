// KYC sessions and tiers (T-0401, enabling REQ-CRD-001) over KycPort. The API keeps the provider's
// session reference and its decision; the capture happens in the provider's SDK with a short-lived
// client token that passes through this service once and is never stored or logged (constitution
// art. 9: no KYC images, no document data). A tier is approved for a party when any session for that
// tier (T2 covers T1) has an approved decision; the card programme gates on that (T-0402).
import { DomainError } from '@kesher/domain';
import { KycError, type KycDecision, type KycPort, type KycTier } from '@kesher/ports';
import type { Database } from '../db.ts';
import type { WebhookVerifier } from '../webhooks/verify.ts';
import type { InboundEvent } from '../webhooks/store.ts';

export type KycState = 'none' | 'pending' | 'approved' | 'rejected' | 'review';

export interface KycSessionView {
  sessionId: string;
  tier: KycTier;
  status: Exclude<KycState, 'none'>;
  reasons: readonly string[];
  startedAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export interface KycStatusView {
  /** The latest session's status, or 'none' before any session. */
  status: KycState;
  /** Highest tier approved so far, if any. */
  approvedTier?: KycTier;
  current?: KycSessionView;
}

export interface StartedSession extends KycSessionView {
  /** For the provider's capture SDK only. Returned once; never persisted. */
  clientToken: string;
}

const TIERS: readonly KycTier[] = ['T1', 'T2'];
const rank = (t: KycTier): number => TIERS.indexOf(t);

interface Row {
  session_id: string;
  party_id: string;
  tier: KycTier;
  status: Exclude<KycState, 'none'>;
  reasons: string[];
  started_at: string | Date;
  expires_at: string | Date;
  decided_at: string | Date | null;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const view = (r: Row): KycSessionView => ({ sessionId: r.session_id, tier: r.tier, status: r.status, reasons: r.reasons, startedAt: iso(r.started_at), expiresAt: iso(r.expires_at), ...(r.decided_at ? { decidedAt: iso(r.decided_at) } : {}) });

export class KycService {
  private readonly db: Database;
  private readonly port: KycPort;
  private readonly market: 'US' | 'IL';
  private readonly provider: string;
  constructor(
    db: Database,
    port: KycPort,
    market: 'US' | 'IL',
    provider = 'issuer-kyc',
  ) {
    this.db = db;
    this.port = port;
    this.market = market;
    this.provider = provider;
  }

  /**
   * Starts a session, or by idempotency key re-reads the one already started. A tier already approved
   * is not started again; after a rejection the member may start afresh.
   */
  async start(partyId: string, tier: KycTier, idempotencyKey: string, now: Date): Promise<StartedSession> {
    if (!TIERS.includes(tier)) throw new DomainError('VALIDATION_FAILED', 'tier must be T1 or T2');
    const status = await this.status(partyId);
    if (status.approvedTier && rank(status.approvedTier) >= rank(tier)) throw new DomainError('VALIDATION_FAILED', `${tier} is already approved`);
    let session;
    try {
      session = await this.port.start({ partyId, tier, market: this.market }, idempotencyKey);
    } catch (e) {
      if (e instanceof KycError && e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'Identity verification is unavailable right now');
      throw e;
    }
    const r = await this.db.query<Row>(
      `insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, updated_at)
       values ($1, $2, $3, $4, $5, 'pending', $6, $7, $6)
       on conflict (session_id) do update set updated_at = identity.kyc_session.updated_at
       returning *`,
      [session.sessionId, partyId, tier, this.market, this.provider, now, new Date(session.expiresAt)],
    );
    return { ...view(r.rows[0]!), clientToken: session.clientToken };
  }

  async status(partyId: string): Promise<KycStatusView> {
    const r = await this.db.query<Row>(`select * from identity.kyc_session where party_id = $1 order by started_at desc, (decided_at is null) desc, session_id desc`, [partyId]);
    const approved = r.rows.filter((x) => x.status === 'approved').map((x) => x.tier).sort((a, b) => rank(b) - rank(a))[0];
    const current = r.rows[0];
    return { status: current ? current.status : 'none', ...(approved ? { approvedTier: approved } : {}), ...(current ? { current: view(current) } : {}) };
  }

  /** True when the party holds an approved decision at `tier` or above. */
  async isApproved(partyId: string, tier: KycTier): Promise<boolean> {
    const s = await this.status(partyId);
    return s.approvedTier !== undefined && rank(s.approvedTier) >= rank(tier);
  }

  /** Feature gate for the card programme and anything else that needs a verified person. */
  async requireApproved(partyId: string, tier: KycTier): Promise<void> {
    if (!(await this.isApproved(partyId, tier))) {
      const s = await this.status(partyId);
      throw new DomainError('FORBIDDEN', s.status === 'pending' || s.status === 'review' ? `Identity verification (${tier}) is still ${s.status}` : `Identity verification (${tier}) is required`);
    }
  }

  /**
   * Webhook verifier for the provider binding: the port checks the signature and parses the decision,
   * so the stored event is the decision itself. A bad signature is stored and refused, as for every
   * provider (THR-02); duplicate event ids are the store's job.
   */
  webhookVerifier(): WebhookVerifier {
    return {
      verify: async (headers, rawBody) => {
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return { ok: false, eventId: '', payload: undefined, reason: 'malformed json' };
        }
        const eventId = typeof (body as { eventId?: unknown })?.eventId === 'string' ? (body as { eventId: string }).eventId : '';
        try {
          const decision = await this.port.parseWebhook(headers, body);
          return { ok: true, eventId: decision.eventId, payload: decision };
        } catch (e) {
          if (e instanceof KycError && e.code === 'BAD_SIGNATURE') return { ok: false, eventId, payload: body, reason: 'bad signature' };
          if (e instanceof KycError && e.code === 'UNKNOWN_SESSION') return { ok: false, eventId, payload: body, reason: 'unknown session' };
          throw e;
        }
      },
    };
  }

  /**
   * Applies a verified decision event. Idempotent: the same event id applied twice changes nothing. Returns the
   * session's party and its standing decision either way, so what follows an approval (a roster member's
   * activation, T-0626) still runs when a replay retries an event whose decision was already applied.
   */
  async applyDecision(event: InboundEvent): Promise<{ partyId: string; tier: KycTier; status: Exclude<KycState, 'none'> }> {
    const d = event.payload as KycDecision & { eventId: string };
    if (!d || typeof d.sessionId !== 'string' || typeof d.status !== 'string') throw new DomainError('VALIDATION_FAILED', 'Decision payload incomplete');
    await this.db.query(
      `update identity.kyc_session set status = $2, reasons = $3, decided_at = coalesce($4, decided_at), last_event_id = $5, updated_at = now()
        where session_id = $1 and (last_event_id is distinct from $5)`,
      [d.sessionId, d.status, [...(d.reasons ?? [])], d.decidedAt ? new Date(d.decidedAt) : null, d.eventId],
    );
    const after = await this.db.query<Pick<Row, 'party_id' | 'tier' | 'status'>>('select party_id, tier, status from identity.kyc_session where session_id = $1', [d.sessionId]);
    const row = after.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Decision for an unknown session');
    return { partyId: row.party_id, tier: row.tier, status: row.status };
  }
}

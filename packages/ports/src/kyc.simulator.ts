// KycPort simulator. Fixtures by partyId suffix: "…-reject" -> rejected, "…-review" -> review,
// "…-outage" -> PROVIDER_UNAVAILABLE, otherwise approved. Decisions arrive when the control panel
// (or a test) calls `decide()`, or via a webhook body `{ eventId, sessionId, status }` signed with
// header `x-sim-signature: sim`.
import { addMs, type Clock, DAY, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { KycError, type KycDecision, type KycPort, type KycSession, type KycTier } from './kyc.ts';

export class KycSimulator implements KycPort {
  private readonly sessions = new Map<string, KycDecision & { partyId: string }>();
  private readonly starts = new IdempotencyStore<KycSession>();
  private readonly events = new Map<string, KycDecision & { eventId: string }>();
  private readonly ids = new Sequence('kyc');

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async start(input: { partyId: string; tier: KycTier; market: 'US' | 'IL' }, idempotencyKey: string): Promise<KycSession> {
    if (input.partyId.endsWith('-outage')) throw new KycError('PROVIDER_UNAVAILABLE', 'Simulated KYC outage');
    return this.starts.run(idempotencyKey, async () => {
      const sessionId = this.ids.next();
      this.sessions.set(sessionId, { sessionId, status: 'pending', tier: input.tier, reasons: [], partyId: input.partyId });
      return { sessionId, clientToken: `ct_${sessionId}`, tier: input.tier, expiresAt: addMs(this.clock.now(), 7 * DAY).toISOString() };
    });
  }

  async getDecision(sessionId: string): Promise<KycDecision> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new KycError('UNKNOWN_SESSION', sessionId);
    const { partyId: _p, ...decision } = s;
    return decision;
  }

  async parseWebhook(headers: Record<string, string>, body: unknown): Promise<KycDecision & { eventId: string }> {
    if (headers['x-sim-signature'] !== 'sim') throw new KycError('BAD_SIGNATURE', 'Webhook signature invalid');
    const b = body as { eventId: string; sessionId: string; status?: KycDecision['status'] };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const decision = this.decide(b.sessionId, b.status);
    const out = { ...decision, eventId: b.eventId };
    this.events.set(b.eventId, out);
    return out;
  }

  /** Control-panel hook: settle a session. Without a status, the party-id fixture decides. */
  decide(sessionId: string, status?: KycDecision['status']): KycDecision {
    const s = this.sessions.get(sessionId);
    if (!s) throw new KycError('UNKNOWN_SESSION', sessionId);
    const fixture = s.partyId.endsWith('-reject') ? 'rejected' : s.partyId.endsWith('-review') ? 'review' : 'approved';
    const final = status ?? fixture;
    const reasons = final === 'rejected' ? ['DOCUMENT_MISMATCH'] : final === 'review' ? ['MANUAL_REVIEW'] : [];
    Object.assign(s, { status: final, reasons, decidedAt: this.clock.now().toISOString() });
    const { partyId: _p, ...decision } = s;
    return decision;
  }
}

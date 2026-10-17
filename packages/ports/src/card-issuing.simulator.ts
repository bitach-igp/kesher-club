// CardIssuingPort simulator. Fixtures: kycSessionId "kyc_outage" -> PROVIDER_UNAVAILABLE;
// JIT requests are JSON signed with `x-sim-signature: sim`. `authorize()` is the control-panel hook
// that builds a signed request for a card, so the API's JIT handler can be driven in tests.
import { toWire, fromWire } from '@kesher/domain';
import { addMs, type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { CardIssuingError, type Card, type CardControls, type CardIssuingPort, type CardStatus, type CardType, type JitAuthorizationRequest, type JitDecision } from './card-issuing.ts';

export class CardIssuingSimulator implements CardIssuingPort {
  private readonly cardholders = new Set<string>();
  private readonly cards = new Map<string, Card>();
  private readonly idem = new IdempotencyStore<unknown>();
  private readonly ids = new Sequence('card');
  private readonly chIds = new Sequence('ch');
  private readonly authIds = new Sequence('auth');

  constructor(readonly clock: Clock = fixedClock()) {}

  async createCardholder(input: { partyId: string; kycSessionId: string }, key: string): Promise<{ cardholderId: string }> {
    if (input.kycSessionId === 'kyc_outage') throw new CardIssuingError('PROVIDER_UNAVAILABLE', 'Simulated processor outage');
    return (await this.idem.run(key, async () => {
      const cardholderId = this.chIds.next();
      this.cardholders.add(cardholderId);
      return { cardholderId };
    })) as { cardholderId: string };
  }

  async issueCard(input: { cardholderId: string; type: CardType; controls: CardControls; shipTo?: { country: 'US' | 'IL' } }, key: string): Promise<Card> {
    if (!this.cardholders.has(input.cardholderId)) throw new CardIssuingError('UNKNOWN_CARDHOLDER', input.cardholderId);
    if (input.type === 'physical' && !input.shipTo) throw new CardIssuingError('VALIDATION_FAILED', 'Physical cards need a shipping country');
    return (await this.idem.run(key, async () => {
      const cardId = this.ids.next();
      const card: Card = {
        cardId,
        cardholderId: input.cardholderId,
        type: input.type,
        status: input.type === 'virtual' ? 'active' : 'inactive',
        last4: cardId.slice(-4),
        currency: 'USD',
        controls: input.controls,
        ...(input.type === 'physical' ? { shipping: { trackingUrl: `https://track.sim.kesher.example/${cardId}` } } : {}),
      };
      this.cards.set(cardId, card);
      return { ...card };
    })) as Card;
  }

  async setStatus(cardId: string, status: Exclude<CardStatus, 'inactive'>, key: string): Promise<Card> {
    return (await this.idem.run(key, async () => {
      const c = this.must(cardId);
      if (c.status === 'closed') throw new CardIssuingError('INVALID_STATE', 'Card is closed');
      if (c.status === 'inactive' && status === 'active') throw new CardIssuingError('INVALID_STATE', 'Activate with activate()');
      const next = { ...c, status };
      this.cards.set(cardId, next);
      return { ...next };
    })) as Card;
  }

  async updateControls(cardId: string, controls: CardControls, key: string): Promise<Card> {
    return (await this.idem.run(key, async () => {
      const next = { ...this.must(cardId), controls };
      this.cards.set(cardId, next);
      return { ...next };
    })) as Card;
  }

  async getCard(cardId: string): Promise<Card> {
    return { ...this.must(cardId) };
  }

  async showDetailsToken(cardId: string): Promise<{ token: string; expiresAt: string }> {
    this.must(cardId);
    return { token: `sdt_${cardId}_${this.clock.now().getTime()}`, expiresAt: addMs(this.clock.now(), 60_000).toISOString() };
  }

  async activate(cardId: string, input: { last4: string }, key: string): Promise<Card> {
    return (await this.idem.run(key, async () => {
      const c = this.must(cardId);
      if (c.type !== 'physical' || c.status !== 'inactive') throw new CardIssuingError('INVALID_STATE', 'Only an inactive physical card activates');
      if (input.last4 !== c.last4) throw new CardIssuingError('VALIDATION_FAILED', 'last4 mismatch');
      const next: Card = { ...c, status: 'active', shipping: { ...c.shipping, activatedAt: this.clock.now().toISOString() } };
      this.cards.set(cardId, next);
      return { ...next };
    })) as Card;
  }

  async parseAuthorization(headers: Record<string, string>, rawBody: string): Promise<JitAuthorizationRequest> {
    if (headers['x-sim-signature'] !== 'sim') throw new CardIssuingError('BAD_SIGNATURE', 'JIT signature invalid');
    const b = JSON.parse(rawBody) as Omit<JitAuthorizationRequest, 'amount'> & { amount: { minor: string; currency: string } };
    return { ...b, amount: fromWire(b.amount) };
  }

  encodeDecision(decision: JitDecision): { status: number; body: unknown } {
    return decision.approve
      ? { status: 200, body: { result: 'APPROVED', holdAmount: toWire(decision.holdAmount) } }
      : { status: 200, body: { result: 'DECLINED', reason: decision.reason } };
  }

  /** Control-panel hook: a signed JIT request for a card. */
  authorize(cardId: string, input: Omit<JitAuthorizationRequest, 'authId' | 'cardId' | 'receivedAt' | 'amount'> & { amount: { minor: bigint; currency: 'USD' | 'ILS' } }): { headers: Record<string, string>; rawBody: string } {
    const req = { ...input, authId: this.authIds.next(), cardId, receivedAt: this.clock.now().toISOString(), amount: toWire(input.amount) };
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify(req) };
  }

  private must(id: string): Card {
    const c = this.cards.get(id);
    if (!c) throw new CardIssuingError('UNKNOWN_CARD', id);
    return c;
  }
}

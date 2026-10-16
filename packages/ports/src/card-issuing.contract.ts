// CardIssuingPort contract (TST-CRD-001/002/004/009 at the port layer; the adapter for ADR-006's
// processor must pass it against the sandbox before card.virtual turns on).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { CardIssuingError, type CardControls, type CardIssuingPort } from './card-issuing.ts';

export interface CardIssuingContractOptions {
  kycSessionId: string;
  outageKycSessionId?: string;
  /** Builds a signed JIT authorisation for a card with the given amount (minor USD). */
  jitRequest: (port: CardIssuingPort, cardId: string, amountMinor: bigint, extra?: { tokenId?: string; agentic?: boolean }) => Promise<{ headers: Record<string, string>; rawBody: string }>;
}

const controls: CardControls = { blockedMccs: ['7995'], atm: false, online: true, agentPurchases: 'off' };
const LUHN = /\b(?:\d[ -]?){13,19}\b/;

export function cardIssuingContract(name: string, make: () => CardIssuingPort, opts: CardIssuingContractOptions): void {
  describe(`CardIssuingPort contract: ${name}`, () => {
    it('issues an active virtual card idempotently', async () => {
      const port = make();
      const { cardholderId } = await port.createCardholder({ partyId: 'p1', kycSessionId: opts.kycSessionId }, 'ch-1');
      const a = await port.issueCard({ cardholderId, type: 'virtual', controls }, 'card-1');
      const b = await port.issueCard({ cardholderId, type: 'virtual', controls }, 'card-1');
      expect(b.cardId).toBe(a.cardId);
      expect(a.status).toBe('active');
      expect(a.last4).toMatch(/^.{4}$/);
    });

    it('never exposes a PAN: card objects and detail tokens contain no 13–19 digit sequence (REQ-CRD-002)', async () => {
      const port = make();
      const { cardholderId } = await port.createCardholder({ partyId: 'p2', kycSessionId: opts.kycSessionId }, 'ch-2');
      const card = await port.issueCard({ cardholderId, type: 'virtual', controls }, 'card-2');
      const token = await port.showDetailsToken(card.cardId);
      expect(JSON.stringify(card)).not.toMatch(LUHN);
      expect(JSON.stringify(token)).not.toMatch(LUHN);
      expect(token.token).toBeTruthy();
    });

    it('freeze and unfreeze change status; a closed card cannot be reopened', async () => {
      const port = make();
      const { cardholderId } = await port.createCardholder({ partyId: 'p3', kycSessionId: opts.kycSessionId }, 'ch-3');
      const card = await port.issueCard({ cardholderId, type: 'virtual', controls }, 'card-3');
      expect((await port.setStatus(card.cardId, 'frozen', 'f-1')).status).toBe('frozen');
      expect((await port.setStatus(card.cardId, 'active', 'f-2')).status).toBe('active');
      await port.setStatus(card.cardId, 'closed', 'f-3');
      await expect(port.setStatus(card.cardId, 'active', 'f-4')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('physical cards ship inactive with tracking and activate with last4 (REQ-CRD-009)', async () => {
      const port = make();
      const { cardholderId } = await port.createCardholder({ partyId: 'p4', kycSessionId: opts.kycSessionId }, 'ch-4');
      const card = await port.issueCard({ cardholderId, type: 'physical', controls, shipTo: { country: 'IL' } }, 'card-4');
      expect(card.status).toBe('inactive');
      expect(card.shipping?.trackingUrl).toMatch(/^https:\/\//);
      await expect(port.activate(card.cardId, { last4: '0000' }, 'a-0')).rejects.toBeInstanceOf(CardIssuingError);
      const active = await port.activate(card.cardId, { last4: card.last4 }, 'a-1');
      expect(active.status).toBe('active');
      expect(active.shipping?.activatedAt).toBeTruthy();
    });

    it('parses a signed JIT request with Money amounts and rejects a bad signature', async () => {
      const port = make();
      const { cardholderId } = await port.createCardholder({ partyId: 'p5', kycSessionId: opts.kycSessionId }, 'ch-5');
      const card = await port.issueCard({ cardholderId, type: 'virtual', controls }, 'card-5');
      const req = await opts.jitRequest(port, card.cardId, 1250n, { tokenId: 'tok_1' });
      const parsed = await port.parseAuthorization(req.headers, req.rawBody);
      expect(parsed.cardId).toBe(card.cardId);
      expect(parsed.amount).toEqual(money(1250n, 'USD'));
      expect(parsed.tokenId).toBe('tok_1');
      await expect(port.parseAuthorization({ 'x-sim-signature': 'forged', 'x-signature': 'forged' }, req.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('encodes approve and decline decisions', () => {
      const port = make();
      expect(port.encodeDecision({ approve: true, holdAmount: money(1n, 'USD') }).status).toBe(200);
      expect(JSON.stringify(port.encodeDecision({ approve: false, reason: 'CARD_FROZEN' }).body)).toContain('CARD_FROZEN');
    });

    if (opts.outageKycSessionId) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().createCardholder({ partyId: 'p6', kycSessionId: opts.outageKycSessionId! }, 'ch-6')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

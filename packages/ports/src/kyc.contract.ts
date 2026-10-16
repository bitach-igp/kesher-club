// KycPort contract. Every adapter: idempotent start, typed errors, signed + deduped webhooks, no PII in decisions.
import { describe, expect, it } from 'vitest';
import { KycError, type KycPort } from './kyc.ts';

export interface KycContractOptions {
  /** Drives a decision for a session (simulator: decide(); sandbox: provider test endpoint). */
  settle: (port: KycPort, sessionId: string, status: 'approved' | 'rejected') => Promise<void>;
  /** Builds a webhook the port will accept for the given session and status. */
  webhook: (sessionId: string, status: 'approved' | 'rejected', eventId: string) => { headers: Record<string, string>; body: unknown };
  outagePartyId?: string;
}

export function kycContract(name: string, make: () => KycPort, opts: KycContractOptions): void {
  describe(`KycPort contract: ${name}`, () => {
    const input = { partyId: 'party_1', tier: 'T2' as const, market: 'IL' as const };

    it('starts a session idempotently and begins pending', async () => {
      const port = make();
      const a = await port.start(input, 'k1');
      const b = await port.start(input, 'k1');
      expect(b.sessionId).toBe(a.sessionId);
      expect(a.clientToken).toBeTruthy();
      expect((await port.getDecision(a.sessionId)).status).toBe('pending');
    });

    it('reaches approved / rejected with reason codes and no PII', async () => {
      const port = make();
      const s = await port.start(input, 'k2');
      await opts.settle(port, s.sessionId, 'rejected');
      const d = await port.getDecision(s.sessionId);
      expect(d.status).toBe('rejected');
      expect(d.reasons.length).toBeGreaterThan(0);
      expect(JSON.stringify(d)).not.toMatch(/name|dob|address|passport/i);
    });

    it('verifies webhook signatures and dedupes by event id', async () => {
      const port = make();
      const s = await port.start(input, 'k3');
      const good = opts.webhook(s.sessionId, 'approved', 'evt-1');
      const first = await port.parseWebhook(good.headers, good.body);
      const second = await port.parseWebhook(good.headers, good.body);
      expect(first.status).toBe('approved');
      expect(second).toEqual(first);
      await expect(port.parseWebhook({ ...good.headers, 'x-sim-signature': 'forged', 'x-signature': 'forged' }, good.body)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('rejects unknown sessions with a typed error', async () => {
      await expect(make().getDecision('nope')).rejects.toBeInstanceOf(KycError);
    });

    if (opts.outagePartyId) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().start({ ...input, partyId: opts.outagePartyId! }, 'k4')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

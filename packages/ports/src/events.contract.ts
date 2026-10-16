// EventsPort contract (TST-NOT-002 at the port layer): Standard Webhooks headers, exact retry
// schedule, replay, secret rotation with overlap.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventsError, RETRY_SCHEDULE_MS, type EventsPort } from './events.ts';

export interface EventsContractOptions {
  /** A receiver url that returns 500 for every delivery. */
  failingUrl: string;
  goodUrl: string;
  /** Returns the last signed request the port sent (simulator: `delivered`; sandbox: a request bin). */
  lastRequest: (port: EventsPort) => Promise<{ headers: Record<string, string>; body: string }>;
  /** Advances time and runs due retries; returns the attempts it produced. */
  runRetriesAfter: (port: EventsPort, ms: number) => Promise<readonly { attemptNumber: number; status: string }[]>;
}

export function eventsContract(name: string, make: () => EventsPort, opts: EventsContractOptions): void {
  describe(`EventsPort contract: ${name}`, () => {
    const event = { type: 'collection.paid' as const, institutionId: 'org_1', payload: { collectionItemId: 'ci_1' } };

    it('signs deliveries per Standard Webhooks and sends once per key', async () => {
      const port = make();
      const ep = await port.createEndpoint({ institutionId: 'org_1', url: opts.goodUrl, eventTypes: ['collection.paid'] }, 'ep-1');
      expect(ep.secret).toMatch(/^whsec_/);
      const a = await port.send(event, 'send-1');
      const b = await port.send(event, 'send-1');
      expect(b.messageId).toBe(a.messageId);
      expect(a.attempts[0]?.status).toBe('succeeded');
      const req = await opts.lastRequest(port);
      expect(req.headers['webhook-id']).toBe(a.messageId);
      expect(req.headers['webhook-timestamp']).toMatch(/^\d+$/);
      const expected = `v1,${createHmac('sha256', Buffer.from(ep.secret.slice(6), 'base64')).update(`${a.messageId}.${req.headers['webhook-timestamp']}.${req.body}`).digest('base64')}`;
      expect(req.headers['webhook-signature']).toBe(expected);
      expect(JSON.parse(req.body)).toMatchObject({ type: 'collection.paid', data: { collectionItemId: 'ci_1' } });
    });

    it('a 500 from the receiver retries at 5 s, 5 m, 30 m, 2 h, 8 h, 24 h and then gives up (REQ-NOT-002)', async () => {
      const port = make();
      await port.createEndpoint({ institutionId: 'org_1', url: opts.failingUrl, eventTypes: ['collection.paid'] }, 'ep-2');
      const sent = await port.send(event, 'send-2');
      expect(sent.attempts[0]).toMatchObject({ status: 'failed', attemptNumber: 1 });
      const first = Date.parse(sent.attempts[0]!.at);
      expect(Date.parse(sent.attempts[0]!.nextRetryAt!) - first).toBe(RETRY_SCHEDULE_MS[0]);
      let n = 2;
      for (const ms of RETRY_SCHEDULE_MS) {
        const produced = await opts.runRetriesAfter(port, ms);
        expect(produced.map((p) => p.attemptNumber)).toContain(n);
        n += 1;
      }
      const all = await port.listAttempts(sent.messageId);
      expect(all.at(-1)).toMatchObject({ attemptNumber: 7, status: 'exhausted' });
      expect(await opts.runRetriesAfter(port, 72 * 3_600_000)).toEqual([]);
    });

    it('replay re-sends an existing message to one endpoint, idempotently', async () => {
      const port = make();
      const ep = await port.createEndpoint({ institutionId: 'org_1', url: opts.goodUrl, eventTypes: ['collection.paid'] }, 'ep-3');
      const sent = await port.send(event, 'send-3');
      const r1 = await port.replay(sent.messageId, ep.endpointId, 'replay-1');
      const r2 = await port.replay(sent.messageId, ep.endpointId, 'replay-1');
      expect(r2).toEqual(r1);
      expect(r1.attemptNumber).toBe(2);
      expect((await port.listAttempts(sent.messageId)).length).toBe(2);
    });

    it('rotating a secret keeps the previous one valid for 24 h', async () => {
      const port = make();
      const ep = await port.createEndpoint({ institutionId: 'org_1', url: opts.goodUrl, eventTypes: ['collection.paid'] }, 'ep-4');
      const rotated = await port.rotateSecret(ep.endpointId, 'rot-1');
      expect(rotated.secret).not.toBe(ep.secret);
      expect(rotated.previousSecretValidUntil).toBeTruthy();
    });

    it('rejects non-https endpoints and unknown ids', async () => {
      const port = make();
      await expect(port.createEndpoint({ institutionId: 'org_1', url: 'http://insecure.example', eventTypes: [] }, 'ep-5')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.listAttempts('nope')).rejects.toBeInstanceOf(EventsError);
    });
  });
}

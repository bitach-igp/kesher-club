// Token lifecycle sweep (T-0405, REQ-CRD-007): pending card-issuing events are applied within the
// job's cycle, deduped by event id, failures recorded and retried, and the lag reported against the
// 60 s SLA.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { CardIssuingSimulator, KycSimulator, fixedClock } from '@kesher/ports';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { CardService } from '@kesher/api/cards/service';
import { detailsTokenProvisioning, ProvisioningService } from '@kesher/api/cards/provisioning';
import { KycService } from '@kesher/api/kyc/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { InboundEventStore } from '@kesher/api/webhooks/store';
import { CYCLE_MS, PROVIDER, SLA_MS, TokenEventsJob } from './token-events.ts';

let db: TestDatabase;
let store: InboundEventStore;
let provisioning: ProvisioningService;
let cardId = '';
let processorCardId = '';
const NOW = new Date('2026-11-01T09:00:00Z');
const clock = fixedClock(NOW.toISOString());

const event = (eventId: string, type: string, tokenId: string, extra: Record<string, unknown> = {}, receivedAt = NOW) =>
  store.record({ provider: PROVIDER, eventId, signatureOk: true, payload: { eventId, type, tokenId, cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1', ...extra }, receivedAt });
const tokenRows = async () => (await db.query<{ token_id: string; status: string; last_event_id: string | null }>(`select token_id, status, last_event_id from cards.card_token where card_id = $1 order by token_id`, [cardId])).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  store = new InboundEventStore(db);
  const kycSim = new KycSimulator(clock);
  const kyc = new KycService(db, kycSim, 'IL');
  const cardSim = new CardIssuingSimulator(clock);
  const cards = new CardService(db, cardSim, kyc, new StaticFlags(undefined, { 'card.virtual': true }));
  provisioning = new ProvisioningService(db, cards, detailsTokenProvisioning(cardSim), new StaticFlags(undefined, { 'card.pushProvisioning': true }));
  const party = uuidv7(NOW);
  const s = await kyc.start(party, 'T2', `kyc:${party}`, NOW);
  const decision = kycSim.decide(s.sessionId, 'approved');
  await kyc.applyDecision({ provider: 'kyc', eventId: 'kyc-1', receivedAt: NOW.toISOString(), signatureOk: true, payload: { ...decision, eventId: 'kyc-1' } });
  const issued = await cards.issueVirtual(party, NOW);
  cardId = issued.id;
  processorCardId = issued.processorCardId;
}, 60_000);
afterAll(async () => db.close());

describe('TokenEventsJob (TST-CRD-007)', () => {
  it('applies pending created, suspended and deleted events in order within one cycle and marks them processed', async () => {
    await event('e1', 'token.created', 'dpan_1');
    await event('e2', 'token.created', 'dpan_2', { wallet: 'google', deviceId: 'pixel-1' });
    await event('e3', 'token.suspended', 'dpan_2', { wallet: 'google', deviceId: 'pixel-1' });
    const job = new TokenEventsJob(store, (e, now) => provisioning.applyTokenEvent(e, now), () => NOW);
    const r = await job.run();
    expect(r).toMatchObject({ attempted: 3, applied: 3, failed: [], lagMs: 0, withinSla: true });
    expect(await tokenRows()).toEqual([{ token_id: 'dpan_1', status: 'active', last_event_id: 'e1' }, { token_id: 'dpan_2', status: 'suspended', last_event_id: 'e3' }]);
    expect(await store.pending(10, PROVIDER)).toEqual([]);
    expect(CYCLE_MS).toBeLessThan(SLA_MS);
  });

  it('a duplicate event id is one stored row and one application; a replay of an applied event changes nothing', async () => {
    const first = await event('e1', 'token.deleted', 'dpan_1');
    expect(first.duplicate).toBe(true);
    const job = new TokenEventsJob(store, (e, now) => provisioning.applyTokenEvent(e, now), () => NOW);
    expect((await job.run()).attempted).toBe(0);
    expect((await tokenRows())[0]).toEqual({ token_id: 'dpan_1', status: 'active', last_event_id: 'e1' });
    const replay = await provisioning.applyTokenEvent({ provider: PROVIDER, eventId: 'e1', receivedAt: NOW.toISOString(), signatureOk: true, payload: { eventId: 'e1', type: 'token.deleted', tokenId: 'dpan_1', cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1' } }, NOW);
    expect(replay.applied).toBe(false);
  });

  it('a failing event is recorded with its error and retried next cycle; the lag reports against the SLA', async () => {
    await event('e4', 'token.created', 'dpan_9', { cardId: 'card_999999' }, new Date(NOW.getTime() - 90_000));
    const job = new TokenEventsJob(store, (e, now) => provisioning.applyTokenEvent(e, now), () => NOW);
    const r = await job.run();
    expect(r.failed).toEqual([{ eventId: 'e4', error: 'Token event for an unknown card' }]);
    expect(r.withinSla).toBe(false);
    expect(r.lagMs).toBe(90_000);
    const stored = await store.get(PROVIDER, 'e4');
    expect(stored?.error).toBe('Token event for an unknown card');
    expect(stored?.processedAt).toBeUndefined();
    // Still pending next cycle; an unsigned event never is.
    await store.record({ provider: PROVIDER, eventId: 'e5', signatureOk: false, payload: { eventId: 'e5', type: 'token.created', tokenId: 'dpan_x', cardId: processorCardId, wallet: 'apple', deviceId: 'z' }, receivedAt: NOW });
    expect((await store.pending(10, PROVIDER)).map((e) => e.eventId)).toEqual(['e4']);
  });
});

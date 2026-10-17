// TST-NOT-002: outbound webhooks use Standard Webhooks signing with retries (exponential backoff,
// 72 h) and a replay UI. Given a 500 from the receiver, retries at 5 s, 5 m, 30 m, 2 h, 8 h, 24 h.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { EventsSimulator, RETRY_SCHEDULE_MS, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { OutboxPublisher, enqueue } from '../transfers/outbox.ts';
import { OutboundEventsService } from './outbound.ts';
import { PostgresPreferenceStore } from '../notify/preferences.ts';

let db: TestDatabase;
let clock: AdvanceableClock;
let sim: EventsSimulator;
let svc: OutboundEventsService;
let institutionId: string;
const staff = uuidv7();

beforeAll(async () => {
  db = await createTestDatabase();
  clock = fixedClock('2026-11-01T10:00:00Z') as AdvanceableClock;
  sim = new EventsSimulator(clock);
  svc = new OutboundEventsService(db, sim);
  institutionId = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshiva', 'IL')`, [institutionId]);
}, 60_000);
afterAll(async () => db.close());

describe('outbound webhooks (REQ-NOT-002)', () => {
  it('registers an https endpoint, returns the secret once, and never stores it', async () => {
    const ep = await svc.createEndpoint({ institutionId, url: 'https://console.yeshiva.example/hooks/kesher', eventTypes: ['collection.paid', 'allowance.run.completed'], createdBy: staff }, clock.now());
    expect(ep.secret).toMatch(/^whsec_/);
    const row = await db.query('select * from notify.outbound_endpoint where endpoint_id = $1', [ep.endpointId]);
    expect(JSON.stringify(row.rows)).not.toContain(ep.secret);
    await expect(svc.createEndpoint({ institutionId, url: 'http://plain.example', eventTypes: ['collection.paid'], createdBy: staff }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(svc.createEndpoint({ institutionId, url: 'https://x.example', eventTypes: ['made.up' as never], createdBy: staff }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('an institution-facing outbox message becomes a signed, thin webhook; other messages are ignored', async () => {
    const ci = uuidv7();
    await db.transaction((tx) => enqueue(tx, 'collection', ci, 'collection.paid', { institutionId, collectionItemId: ci, memberName: 'Noa Levi', amount: { minor: '120000', currency: 'ILS' } }));
    await db.transaction((tx) => enqueue(tx, 'transfer', uuidv7(), 'transfer.settled', { amount: { minor: '1', currency: 'USD' } }));
    const r = await new OutboxPublisher(db, svc).publishBatch();
    expect(r.failed).toBe(0);
    expect(sim.delivered.length).toBe(1);
    const body = JSON.parse(sim.delivered[0]!.body) as { type: string; data: Record<string, string> };
    expect(body.type).toBe('collection.paid');
    expect(body.data).toEqual({ institutionId, collectionItemId: ci, aggregateId: ci }); // ids only: no name, no amount
    expect(sim.delivered[0]!.headers['webhook-signature']).toMatch(/^v1,/);
    const listed = await svc.messages(institutionId);
    expect(listed.length).toBe(1);
    expect(listed[0]!.attempts[0]!.status).toBe('succeeded');
  });

  it('a failing receiver follows the retry ladder, and ops can replay a message to one endpoint', async () => {
    const other = uuidv7();
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Seminary', 'IL')`, [other]);
    const ep = await svc.createEndpoint({ institutionId: other, url: 'https://sem.example/hooks/fail', eventTypes: ['allowance.run.completed'], createdBy: staff }, clock.now());
    await db.transaction((tx) => enqueue(tx, 'allowance_run', uuidv7(), 'allowance.run.completed', { institutionId: other, paid: '12', failures: '0' }));
    await new OutboxPublisher(db, svc).publishBatch();
    const [msg] = await svc.messages(other);
    expect(msg!.attempts[0]).toMatchObject({ status: 'failed', attemptNumber: 1 });
    expect(Date.parse(msg!.attempts[0]!.nextRetryAt!) - clock.now().getTime()).toBe(RETRY_SCHEDULE_MS[0]);
    for (const ms of RETRY_SCHEDULE_MS) {
      clock.advance(ms);
      sim.runRetries();
    }
    const after = await svc.messages(other);
    expect(after[0]!.attempts.at(-1)).toMatchObject({ attemptNumber: 7, status: 'exhausted' });
    const replayed = await svc.replay(msg!.messageId, ep.endpointId, staff, clock.now());
    expect(replayed.attemptNumber).toBe(8);
    await expect(svc.replay(msg!.messageId, 'ep_other', staff, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('secret rotation keeps the old secret valid for 24 h and is recorded', async () => {
    const ep = await svc.createEndpoint({ institutionId, url: 'https://console.yeshiva.example/hooks/v2', eventTypes: ['collection.paid'], createdBy: staff }, clock.now());
    const rotated = await svc.rotateSecret(ep.endpointId, clock.now());
    expect(rotated.secret).not.toBe(ep.secret);
    expect(rotated.previousSecretValidUntil).toBe(new Date(clock.now().getTime() + 24 * 3_600_000).toISOString());
    expect((await db.query<{ rotated_at: string | null }>('select rotated_at from notify.outbound_endpoint where endpoint_id = $1', [ep.endpointId])).rows[0]!.rotated_at).toBeTruthy();
  });
});

describe('notification preferences store (REQ-NOT-001)', () => {
  it('round-trips preferences and refuses opting out of security or emergency', async () => {
    const store = new PostgresPreferenceStore(db);
    const party = uuidv7();
    expect(await store.get(party)).toBeUndefined();
    const saved = await store.set(party, { optOut: ['marketing'], channels: { money: ['email'] }, timeZone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' } }, clock.now());
    expect(await store.get(party)).toEqual(saved);
    await expect(store.set(party, { optOut: ['security' as never] }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(store.set(party, { timeZone: 'Mars/Olympus' }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

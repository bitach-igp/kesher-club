// T-0205: transfer state machine + transactional outbox. Also exercises THR-04 (double submit
// never creates two transfers) at the service layer; the HTTP layer is TST-PAY-005.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { isPgError } from '../db.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { OutboxPublisher, type OutboxMessage } from './outbox.ts';
import { TransferService } from './service.ts';
import { canTransition, next, TERMINAL_STATES, type TransferEvent, type TransferState } from './state-machine.ts';

let db: TestDatabase;
let transfers: TransferService;
const now = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  transfers = new TransferService(db);
}, 60_000);
afterAll(async () => db.close());

describe('state machine', () => {
  it('follows SEQ-06 and refuses every other transition', () => {
    expect(next('created', 'submit')).toBe('submitted');
    expect(next('submitted', 'hold')).toBe('pending_hold');
    expect(next('pending_hold', 'release_hold')).toBe('pending');
    expect(next('pending', 'settle')).toBe('settled');
    expect(next('settled', 'reverse')).toBe('reversed');
    expect(next('pending_hold', 'cancel')).toBe('cancelled');
    const states: TransferState[] = ['created', 'submitted', 'pending', 'pending_hold', 'settled', 'failed', 'reversed', 'cancelled'];
    const events: TransferEvent[] = ['submit', 'hold', 'release_hold', 'cancel', 'settle', 'fail', 'reverse'];
    for (const s of TERMINAL_STATES) for (const e of events) if (!(s === 'settled' && e === 'reverse')) expect(canTransition(s, e), `${s} ${e}`).toBe(false);
    expect(() => next('settled', 'settle')).toThrow(/Cannot settle/);
    expect(() => next('created', 'settle')).toThrow();
    expect(states.length).toBe(8);
  });
});

describe('TransferService', () => {
  it('stamps the market of the API that created it; the database refuses a transfer without one (T-0027)', async () => {
    const us = await new TransferService(db, 'US').create({ idempotencyKey: `us-${uuidv7()}`, kind: 'load', toPartyId: uuidv7(), amount: money(100n, 'USD') }, now);
    const il = await transfers.create({ idempotencyKey: `il-${uuidv7()}`, kind: 'load', toPartyId: uuidv7(), amount: money(100n, 'ILS') }, now);
    const r = await db.query<{ id: string; market: string }>('select id, market from ops.transfer where id = any($1)', [[us.id, il.id]]);
    expect(Object.fromEntries(r.rows.map((x) => [x.id, x.market]))).toEqual({ [us.id]: 'US', [il.id]: 'IL' });
    const err = await db
      .query(`insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state) values ($1, $2, 'load', $3, 1, 'USD', 'created')`, [uuidv7(), `no-market-${uuidv7()}`, uuidv7()])
      .catch((e: unknown) => e);
    expect(isPgError(err, '23514')).toBe(true);
  });

  it('create is idempotent by key and a replay with a different amount returns the original (THR-04)', async () => {
    const key = `k-${uuidv7()}`;
    const a = await transfers.create({ idempotencyKey: key, kind: 'p2p', fromPartyId: uuidv7(), toPartyId: uuidv7(), amount: money(5_000n, 'ILS') }, now);
    const b = await transfers.create({ idempotencyKey: key, kind: 'p2p', fromPartyId: uuidv7(), toPartyId: uuidv7(), amount: money(9_999n, 'ILS') }, now);
    expect(b.id).toBe(a.id);
    expect(b.amount).toEqual(money(5_000n, 'ILS'));
    expect(a.state).toBe('created');
    const burst = await Promise.all(Array.from({ length: 4 }, () => transfers.create({ idempotencyKey: `burst-${key}`, kind: 'load', toPartyId: uuidv7(), amount: money(1n, 'USD') }, now)));
    expect(new Set(burst.map((t) => t.id)).size).toBe(1);
  });

  it('every state change appends history and an outbox row in the same transaction', async () => {
    const t = await transfers.create({ idempotencyKey: `h-${uuidv7()}`, kind: 'p2p', fromPartyId: uuidv7(), toPartyId: uuidv7(), amount: money(60_000n, 'ILS') }, now);
    await transfers.apply(t.id, 'submit', now);
    const held = await transfers.apply(t.id, 'hold', now, { holdReleasesAt: new Date(now.getTime() + 2 * 3_600_000), reason: 'new counterparty over ₪500' });
    expect(held.state).toBe('pending_hold');
    expect(held.holdReleasesAt).toBe('2026-11-01T12:00:00.000Z');
    expect(await transfers.expiredHolds(new Date('2026-11-01T11:59:59Z'))).toEqual([]);
    expect((await transfers.expiredHolds(new Date('2026-11-01T12:00:00Z'))).map((x) => x.id)).toContain(t.id);
    await transfers.apply(t.id, 'release_hold', now);
    const settled = await transfers.apply(t.id, 'settle', now);
    expect(settled.state).toBe('settled');
    expect((await transfers.history(t.id)).map((h) => h.to)).toEqual(['created', 'submitted', 'pending_hold', 'pending', 'settled']);
    const outbox = await db.query<{ type: string }>(`select type from ops.outbox where aggregate = 'transfer' and aggregate_id = $1 order by id`, [t.id]);
    expect(outbox.rows.map((r) => r.type)).toEqual(['transfer.created', 'transfer.submitted', 'transfer.pending_hold', 'transfer.pending', 'transfer.settled']);
  });

  it('an invalid transition rolls back everything: no row change, no history, no outbox', async () => {
    const t = await transfers.create({ idempotencyKey: `inv-${uuidv7()}`, kind: 'load', toPartyId: uuidv7(), amount: money(100n, 'USD') }, now);
    await expect(transfers.apply(t.id, 'settle', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await transfers.get(t.id))!.state).toBe('created');
    expect((await transfers.history(t.id)).length).toBe(1);
    expect((await db.query(`select 1 from ops.outbox where aggregate_id = $1 and type = 'transfer.settled'`, [t.id])).rowCount).toBe(0);
  });

  it('cancel is only possible before submission or while on hold (REQ-PAY-003)', async () => {
    const t = await transfers.create({ idempotencyKey: `c-${uuidv7()}`, kind: 'p2p', fromPartyId: uuidv7(), toPartyId: uuidv7(), amount: money(10n, 'ILS') }, now);
    await transfers.apply(t.id, 'submit', now);
    await expect(transfers.apply(t.id, 'cancel', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await transfers.apply(t.id, 'hold', now, { holdReleasesAt: new Date(now.getTime() + 7_200_000) });
    expect((await transfers.apply(t.id, 'cancel', now, { reason: 'member cancelled' })).state).toBe('cancelled');
  });

  it('the publisher drains the outbox at least once and leaves failed rows for the next run', async () => {
    const t = await transfers.create({ idempotencyKey: `pub-${uuidv7()}`, kind: 'addon', fromPartyId: uuidv7(), amount: money(2_500n, 'USD') }, now);
    const seen: OutboxMessage[] = [];
    let failFirst = true;
    const publisher = new OutboxPublisher(db, {
      publish: async (m) => {
        if (failFirst && m.aggregateId === t.id) {
          failFirst = false;
          throw new Error('sink down');
        }
        seen.push(m);
      },
    });
    const first = await publisher.publishBatch(1000);
    expect(first.failed).toBe(1);
    const second = await publisher.publishBatch(1000);
    expect(second.failed).toBe(0);
    expect(seen.some((m) => m.aggregateId === t.id && m.type === 'transfer.created')).toBe(true);
    expect(seen.find((m) => m.aggregateId === t.id)!.payload).toMatchObject({ amount: { minor: '2500', currency: 'USD' } });
    expect(await publisher.backlog()).toBe(0);
  });

  it('the app role can run the whole lifecycle (grants on ops.transfer / transfer_event / outbox)', async () => {
    await db.asRole('club_app', async (app) => {
      const svc = new TransferService({ query: app.query, transaction: db.transaction });
      const t = await svc.create({ idempotencyKey: `app-${uuidv7()}`, kind: 'load', toPartyId: uuidv7(), amount: money(1n, 'USD') }, now);
      expect((await svc.apply(t.id, 'submit', now)).state).toBe('submitted');
    });
  });
});

// T-0205: transfer state machine + transactional outbox. Also exercises THR-04 (double submit
// never creates two transfers) at the service layer; the HTTP layer is TST-PAY-005.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { isPgError } from '../db.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { OutboxPublisher, type OutboxMessage } from './outbox.ts';
import { TransferService } from './service.ts';
import { next, TERMINAL_STATES, type TransferEvent, type TransferState } from './state-machine.ts';
import { seedTransfer } from '../test-seed.ts';

let db: TestDatabase;
let transfers: TransferService;
const now = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  transfers = new TransferService(db);
}, 60_000);
afterAll(async () => db.close());

describe('state machine', () => {
  const states: TransferState[] = ['created', 'submitted', 'pending', 'pending_hold', 'settled', 'failed', 'reversed', 'cancelled'];
  const events: TransferEvent[] = ['submit', 'hold', 'release_hold', 'cancel', 'settle', 'fail', 'reverse'];
  // The documented machine (state-machine.ts header, SEQ-06), written out independently of the code's map.
  const LEGAL: Record<string, TransferState> = {
    'created submit': 'submitted', 'created cancel': 'cancelled', 'created fail': 'failed',
    'submitted hold': 'pending_hold', 'submitted settle': 'settled', 'submitted fail': 'failed',
    'pending settle': 'settled', 'pending fail': 'failed',
    'pending_hold release_hold': 'pending', 'pending_hold cancel': 'cancelled', 'pending_hold fail': 'failed',
    'settled reverse': 'reversed',
  };

  it('follows SEQ-06 and refuses every other transition', () => {
    expect(Object.keys(LEGAL).length).toBe(12);
    for (const s of states) for (const e of events) {
      const to = LEGAL[`${s} ${e}`];
      if (to) expect(next(s, e), `${s} ${e}`).toBe(to);
      else expect(() => next(s, e), `${s} ${e}`).toThrow(/Cannot/);
    }
    // terminal states refuse everything except settled + reverse
    for (const s of TERMINAL_STATES) for (const e of events) if (!(s === 'settled' && e === 'reverse')) expect(() => next(s, e), `${s} ${e}`).toThrow(/Cannot/);
    expect(() => next('settled', 'settle')).toThrow(/Cannot settle/);
  });

  it('TransferService.apply, the live path, takes every legal (state, event) pair and refuses every other with IDEMPOTENCY_CONFLICT, leaving the row, history and outbox untouched (T-0784)', async () => {
    const t = new Date('2026-11-02T10:00:00Z');
    for (const s of states) for (const e of events) {
      const id = uuidv7(t);
      await seedTransfer(db, { id, kind: 'load', state: s, market: 'IL', at: t });
      const outbox = async () => (await db.query<{ n: number }>(`select count(*)::int as n from ops.outbox where aggregate_id = $1`, [id])).rows[0]!.n;
      const events0 = async () => (await db.query<{ n: number }>('select count(*)::int as n from ops.transfer_event where transfer_id = $1', [id])).rows[0]!.n;
      const to = LEGAL[`${s} ${e}`];
      if (to) {
        const out = await transfers.apply(id, e, t, e === 'hold' ? { holdReleasesAt: new Date(t.getTime() + 7_200_000) } : {});
        expect(out.state, `${s} ${e}`).toBe(to);
        expect(await events0(), `${s} ${e} history`).toBe(1);
        expect(await outbox(), `${s} ${e} outbox`).toBe(1);
      } else {
        await expect(transfers.apply(id, e, t), `${s} ${e}`).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect((await transfers.get(id))!.state, `${s} ${e} unchanged`).toBe(s);
        expect(await events0(), `${s} ${e} history`).toBe(0);
        expect(await outbox(), `${s} ${e} outbox`).toBe(0);
      }
    }
  });

  it('state-machine.ts exports no canTransition predicate: next() is the one gate (T-0784)', () => {
    expect(readFileSync(new URL('./state-machine.ts', import.meta.url), 'utf8')).not.toContain('canTransition');
  });
});

describe('TransferService', () => {
  it('getMany answers what get answers, in the order asked, skipping an unknown id, in one query (cleanup)', async () => {
    const a = await transfers.create({ idempotencyKey: `many-a-${uuidv7()}`, kind: 'load', toPartyId: uuidv7(), amount: money(100n, 'ILS') }, now);
    const b = await transfers.create({ idempotencyKey: `many-b-${uuidv7()}`, kind: 'payout', fromPartyId: uuidv7(), amount: money(250n, 'USD') }, now);
    await transfers.apply(b.id, 'submit', now);
    const c = await transfers.create({ idempotencyKey: `many-c-${uuidv7()}`, kind: 'load', toPartyId: uuidv7(), amount: money(300n, 'ILS') }, now);
    const ids = [c.id, uuidv7(), a.id, b.id];
    const spy = vi.spyOn(db, 'query');
    const many = await transfers.getMany(ids);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(many).toEqual([(await transfers.get(c.id))!, (await transfers.get(a.id))!, (await transfers.get(b.id))!]);
    expect(await transfers.getMany([])).toEqual([]);
  });

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

  it('expired holds are this market\'s only: each market\'s worker releases its own (T-0028)', async () => {
    const past = new Date(now.getTime() - 60_000);
    const [il, us] = [uuidv7(), uuidv7()];
    await seedTransfer(db, { id: il, kind: 'p2p', state: 'pending_hold', market: 'IL', at: past });
    await seedTransfer(db, { id: us, kind: 'p2p', state: 'pending_hold', market: 'US', at: past });
    const ilHolds = (await transfers.expiredHolds(now)).map((t) => t.id);
    const usHolds = (await new TransferService(db, 'US').expiredHolds(now)).map((t) => t.id);
    expect(ilHolds).toContain(il);
    expect(ilHolds).not.toContain(us);
    expect(usHolds).toEqual([us]);
  });

});

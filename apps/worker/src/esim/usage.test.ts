// TST-ESIM-003: low data (under 20%) and expiry (3 days) trigger notifications. Given usage 81%,
// one push.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { EsimSimulator, NotifySimulator, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { EsimUsagePoller } from './usage.ts';

let db: TestDatabase;
let esim: EsimSimulator;
let notify: NotifySimulator;
let poller: EsimUsagePoller;
let clock: AdvanceableClock;
const member = uuidv7();

async function fulfilledOrder(): Promise<{ orderId: string; iccid: string }> {
  const o = await esim.order('IL-5GB-30D', `o-${uuidv7()}`);
  const orderId = uuidv7();
  await db.query(`insert into addons.addon_order (id, idempotency_key, member_party_id, sku, kind, provider, state, cost_minor, price_minor, list_price_minor, currency, fulfilment, market) values ($1, $2, $3, 'esim:simulator:IL-5GB-30D', 'esim', 'simulator', 'fulfilled', 950, 1199, 1199, 'USD', $4, 'IL')`, [orderId, `k-${orderId}`, member, JSON.stringify({ iccid: o.iccid, installUrl: o.installUrl })]);
  return { orderId, iccid: o.iccid };
}

beforeAll(async () => {
  db = await createTestDatabase();
  clock = fixedClock('2026-11-01T09:00:00Z') as AdvanceableClock;
  esim = new EsimSimulator(() => clock.now());
  notify = new NotifySimulator();
  poller = new EsimUsagePoller(db, () => esim, notify, async (p) => (p === member ? 'ExponentPushToken[member]' : undefined));
  await db.query(`insert into addons.catalogue_item (sku, kind, provider, vendor_sku, title, cost_minor, price_minor, currency, synced_at) values ('esim:simulator:IL-5GB-30D', 'esim', 'simulator', 'IL-5GB-30D', 'IL 5 GB', 950, 1199, 'USD', now())`);
}, 60_000);
afterAll(async () => db.close());

describe('eSIM usage polling (REQ-ESIM-003)', () => {
  it('usage at 81% sends exactly one low-data push, even across repeated polls', async () => {
    const { iccid } = await fulfilledOrder();
    esim.setUsage(iccid, Math.round(5 * 1024 * 0.81));
    const r1 = await poller.poll(clock.now());
    expect(r1).toMatchObject({ polled: 1, lowData: 1, expiring: 0, errors: 0 });
    const r2 = await poller.poll(clock.now());
    expect(r2.lowData).toBe(0);
    const pushes = notify.sent.filter((n) => n.template === 'esim.low_data');
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toMatchObject({ channel: 'push', to: 'ExponentPushToken[member]', data: expect.objectContaining({ leftPct: '19', iccidLast4: iccid.slice(-4) }) });
  });

  it('usage at 79% sends nothing; the record keeps the latest usage', async () => {
    const { iccid, orderId } = await fulfilledOrder();
    esim.setUsage(iccid, Math.round(5 * 1024 * 0.79));
    const before = notify.sent.length;
    await poller.poll(clock.now());
    expect(notify.sent.length).toBe(before);
    const f = await db.query<{ fulfilment: { leftPct: number; usedMb: number } }>('select fulfilment from addons.addon_order where id = $1', [orderId]);
    expect(f.rows[0]!.fulfilment).toMatchObject({ leftPct: 20 }); // 20% left is not under 20%
  });

  it('three days before expiry sends one expiry push; after expiry nothing more', async () => {
    const { iccid } = await fulfilledOrder();
    const before = notify.sent.filter((n) => n.template === 'esim.expiring').length;
    clock.advance(27 * 86_400_000 + 3_600_000); // 2.96 days left
    await poller.poll(clock.now());
    await poller.poll(clock.now());
    expect(notify.sent.filter((n) => n.template === 'esim.expiring' && n.data['iccidLast4'] === iccid.slice(-4)).length).toBe(1);
    expect(notify.sent.filter((n) => n.template === 'esim.expiring').length).toBe(before + 3); // the two earlier eSIMs are expiring too
    clock.advance(4 * 86_400_000);
    const r = await poller.poll(clock.now());
    expect(r.expiring).toBe(0);
  });

  it('a provider error is counted and never notifies the member', async () => {
    const broken = new EsimUsagePoller(db, () => ({ ...esim, getUsage: async () => { throw new Error('vendor 503'); } }) as unknown as EsimSimulator, notify, async () => 'ExponentPushToken[member]');
    const before = notify.sent.length;
    const r = await broken.poll(new Date('2026-11-01T09:00:00Z'));
    expect(r.errors).toBeGreaterThan(0);
    expect(notify.sent.length).toBe(before);
  });
});

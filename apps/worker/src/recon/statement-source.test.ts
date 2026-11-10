// T-0683 (REQ-LED-004): the partner statement read from the funding vendor. The funding simulator stands in for it.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock, FundingSimulator, type AdvanceableClock, type FundingStatementPort, type SettledEntry } from '@kesher/ports';
import type { StatementSource } from './recon.ts';
import { businessDayWindow, FundingStatementSource } from './statement-source.ts';

const usd = (minor: bigint) => money(minor, 'USD');

function setup(pageSize?: number) {
  const clock = fixedClock('2026-11-10T08:00:00Z') as AdvanceableClock;
  const sim = new FundingSimulator(clock);
  const source: StatementSource = new FundingStatementSource({ provider: 'stripe', port: sim, ...(pageSize ? { pageSize } : {}) });
  const load = (minor: bigint, key: string) => sim.createLoad({ customerId: 'c', method: 'card', amount: usd(minor), paymentMethodId: 'pm_ok' }, key);
  return { clock, sim, source, load };
}

describe('FundingStatementSource (REQ-LED-004)', () => {
  it('returns three settled charges for the date as PartnerTransactions with vendor id, currency and bigint minor amount', async () => {
    const { source, load } = setup();
    const a = await load(10_000n, 'load-key-a');
    const b = await load(2_500n, 'load-key-b');
    const c = await load(1n, 'load-key-c');
    const rows = await source.fetch('stripe', '2026-11-10');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.externalId).sort()).toEqual([a.loadId, b.loadId, c.loadId].sort());
    const ra = rows.find((r) => r.externalId === a.loadId)!;
    expect(ra).toEqual({ provider: 'stripe', externalId: a.loadId, amount: usd(10_000n), type: 'charge' });
    expect(typeof ra.amount.minor).toBe('bigint');
  });

  it('a refund is negative and keyed by its refund id', async () => {
    const { sim, source, load } = setup();
    const a = await load(10_000n, 'load-key-a');
    const r = await sim.refund({ loadId: a.loadId, amount: usd(4_000n) }, 'refund-key-a');
    const rows = await source.fetch('stripe', '2026-11-10');
    expect(rows.find((x) => x.externalId === r.refundId)).toEqual({ provider: 'stripe', externalId: r.refundId, amount: usd(-4_000n), type: 'refund' });
    expect(rows.find((x) => x.externalId === a.loadId)!.amount).toEqual(usd(10_000n));
  });

  it('a refund the vendor has not settled is not on the statement until it settles', async () => {
    const { sim, clock, source } = setup();
    const l = await sim.createLoad({ customerId: 'c', method: 'card', amount: usd(5_000n), paymentMethodId: 'pm_slowrefund' }, 'load-key-slow');
    const pending = await sim.refund({ loadId: l.loadId, amount: usd(1_000n) }, 'refund-key-slow');
    expect((await source.fetch('stripe', '2026-11-10')).map((r) => r.externalId)).toEqual([l.loadId]);
    clock.advance(60_000);
    sim.settleRefund(pending.refundId);
    expect((await source.fetch('stripe', '2026-11-10')).map((r) => r.externalId).sort()).toEqual([l.loadId, pending.refundId].sort());
  });

  it('the day is the Asia/Jerusalem business day: 23:30 on the 9th and 00:30 on the 11th local are not the 10th', async () => {
    const { sim, clock, source } = setup();
    const to = (iso: string) => clock.advance(Date.parse(iso) - clock.now().getTime());
    const make = (minor: bigint, key: string) => sim.createLoad({ customerId: 'c', method: 'card', amount: usd(minor), paymentMethodId: 'pm_ok' }, key);
    to('2026-11-09T21:30:00Z'); // 23:30 IST on the 9th
    await make(1n, 'late-9th-key');
    to('2026-11-09T22:00:00Z'); // 00:00 IST on the 10th: the first instant of the day
    const first = await make(2n, 'start-10th-key');
    to('2026-11-10T21:59:59Z'); // 23:59:59 IST on the 10th
    const last = await make(3n, 'end-10th-key');
    to('2026-11-10T22:30:00Z'); // 00:30 IST on the 11th
    await make(4n, 'early-11th-key');
    expect((await source.fetch('stripe', '2026-11-10')).map((r) => r.externalId).sort()).toEqual([first.loadId, last.loadId].sort());
  });

  it('pagination across pages returns every row once', async () => {
    const { sim, load } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await load(BigInt(100 + i), `page-key-${i}`)).loadId);
    const calls: { cursor?: string | undefined; limit?: number | undefined }[] = [];
    const spy: FundingStatementPort = { listSettled: (i) => (calls.push(i), sim.listSettled(i)) };
    const rows = await new FundingStatementSource({ provider: 'stripe', port: spy, pageSize: 2 }).fetch('stripe', '2026-11-10');
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.limit === 2)).toBe(true);
    expect(rows.map((r) => r.externalId).sort()).toEqual([...ids].sort());
    expect(rows.map((r) => r.amount.minor).sort()).toEqual([100n, 101n, 102n, 103n, 104n]);
  });

  it('a vendor outage on the second page throws PROVIDER_UNAVAILABLE and returns no partial list', async () => {
    const { sim, source, load } = setup(2);
    for (let i = 0; i < 5; i++) await load(100n, `outage-key-${i}`);
    sim.outageAfterPages = 1;
    await expect(source.fetch('stripe', '2026-11-10')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a page that repeats a row is refused, not summed twice', async () => {
    const entry: SettledEntry = { kind: 'charge', id: 'load_1', loadId: 'load_1', amount: usd(100n), settledAt: '2026-11-10T08:00:00.000Z' };
    let n = 0;
    const port: FundingStatementPort = { listSettled: async () => ({ entries: [entry], ...(n++ < 1 ? { nextCursor: 'next' } : {}) }) };
    await expect(new FundingStatementSource({ provider: 'stripe', port }).fetch('stripe', '2026-11-10')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('an empty day is an empty statement, not an error', async () => {
    expect(await setup().source.fetch('stripe', '2026-11-11')).toEqual([]);
  });

  it('refuses a provider it was not built for and a date that is not a calendar day', async () => {
    const { source } = setup();
    await expect(source.fetch('processor', '2026-11-10')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(source.fetch('stripe', '2026-02-30')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(source.fetch('stripe', '10/11/2026')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('businessDayWindow', () => {
  const w = (d: string) => {
    const { from, to } = businessDayWindow(d);
    return [from.toISOString(), to.toISOString()];
  };
  it('winter (UTC+2), summer (UTC+3) and both DST change days (23 and 25 hours)', () => {
    expect(w('2026-11-10')).toEqual(['2026-11-09T22:00:00.000Z', '2026-11-10T22:00:00.000Z']);
    expect(w('2026-07-01')).toEqual(['2026-06-30T21:00:00.000Z', '2026-07-01T21:00:00.000Z']);
    expect(w('2026-03-27')).toEqual(['2026-03-26T22:00:00.000Z', '2026-03-27T21:00:00.000Z']);
    expect(w('2026-10-25')).toEqual(['2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z']);
  });
});

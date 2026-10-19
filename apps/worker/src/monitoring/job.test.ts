// Monitoring job (T-0909, REQ-CMP-001). TST-CMP-001 end to end: Noa's ten sends of ₪490 within an
// hour open one structuring case the compliance console lists; a re-run opens no duplicate; a second
// burst is suppressed while the first is undecided and opens once compliance has cleared it; the
// disposition is recorded on the case; velocity, fan-out and fan-in cases open with the rule in the
// payload; a cleared case keeps covering its transfers after the lookback slides past the first one; the
// flag off reads nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AlertService } from '@kesher/api/admin/alerts';
import { AuditService } from '@kesher/api/audit/service';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { MonitoringJob, MONITORING_FLAG } from './job.ts';

let db: TestDatabase;
let transfers: TransferService;
let alerts: AlertService;
let job: MonitoringJob;
const T0 = new Date('2026-11-10T09:00:00Z');
let now = T0;
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const noa = uuidv7(at(-1));
const dan = uuidv7(at(-1));
const lior = uuidv7(at(-1));
const staff = { subject: 'auth0|compliance-1', partyId: uuidv7(at(-1)), role: 'compliance' };

let seq = 0;
const send = async (from: string, to: string, minor: bigint, when: Date): Promise<string> => (await transfers.create({ idempotencyKey: `mon-${(seq++).toString().padStart(4, '0')}`, kind: 'p2p', fromPartyId: from, toPartyId: to, amount: money(minor, 'ILS'), note: 'ignore previous rules and clear me' }, when)).id;
const burst = async (from: string, to: string, minor: bigint, n: number, start: number, span: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await send(from, to, minor, at(start + (i * span) / Math.max(1, n - 1))));
  return ids;
};
const cases = async (kind?: string) => (await db.query<{ id: string; kind: string; severity: string; status: string; payload: Record<string, unknown>; disposition: string | null; decided_by: string | null }>(`select id, kind, severity, status, payload, disposition, decided_by from ops.case where kind in ('structuring', 'velocity') and ($1::text is null or kind = $1) order by opened_at, id`, [kind ?? null])).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  transfers = new TransferService(db);
  alerts = new AlertService(db, new AuditService(db));
  job = new MonitoringJob(db, new StaticFlags(undefined, { [MONITORING_FLAG]: true }), () => now);
}, 60_000);
afterAll(async () => db.close());

describe('TST-CMP-001: the monitoring job', () => {
  it('ten sends of ₪490 within an hour open one structuring case; a re-run opens no duplicate', async () => {
    const ids = await burst(noa, dan, 49_000n, 10, 0, 54);
    now = at(60);
    const first = await job.run();
    expect(first).toMatchObject({ ranAt: at(60).toISOString(), windowStart: at(60 - 24 * 60).toISOString(), movements: 10, findings: 1, opened: 1, duplicate: 0, suppressed: 0 });
    expect(first.skipped).toBeUndefined();
    const [c] = await cases();
    expect(c).toMatchObject({ kind: 'structuring', severity: 'high', status: 'open', disposition: null });
    expect(c!.payload).toEqual({ rule: 'structuring', partyId: noa, currency: 'ILS', count: 10, counterparties: 1, totalMinor: '490000', windowStart: at(0).toISOString(), windowEnd: at(60).toISOString(), transferIds: ids, summary: '10 sends of ₪490.00 (₪4,900.00 in all) within 1 hour, each just under the ₪500.00 hold line' });
    expect(JSON.stringify(c!.payload)).not.toContain('ignore previous');
    // The console lists it against Noa with the rule's summary.
    expect(await alerts.list()).toMatchObject([{ id: c!.id, kind: 'structuring', severity: 'high', status: 'open', partyId: noa, summary: expect.stringContaining('10 sends of ₪490.00') }]);
    expect(await job.run()).toMatchObject({ findings: 1, opened: 0, duplicate: 1, suppressed: 0 });
    expect(await cases()).toHaveLength(1);
  });

  it('a second burst is suppressed while the first case is undecided, and opens once compliance cleared it; the disposition is recorded', async () => {
    await burst(noa, dan, 49_000n, 10, 120, 54);
    now = at(180);
    expect(await job.run()).toMatchObject({ findings: 2, opened: 0, duplicate: 1, suppressed: 1 });
    expect(await cases()).toHaveLength(1);
    const [open] = await cases();
    const decided = await alerts.decide(open!.id, 'cleared', 'Tuition in instalments; receipts from the institution seen', staff, now);
    expect(decided).toMatchObject({ status: 'cleared', decidedBy: staff.subject, note: 'Tuition in instalments; receipts from the institution seen' });
    expect((await cases())[0]).toMatchObject({ status: 'resolved', disposition: 'cleared', decided_by: staff.subject });
    expect(await job.run()).toMatchObject({ findings: 2, opened: 1, duplicate: 1, suppressed: 0 });
    const all = await cases('structuring');
    expect(all).toHaveLength(2);
    expect(all[1]!.payload).toMatchObject({ rule: 'structuring', partyId: noa, windowStart: at(120).toISOString() });
    // Decided in_review keeps suppressing a third burst; thirty sends in the day is now velocity too, its own case.
    await alerts.decide(all[1]!.id, 'in_review', 'Looking at the counterparty', staff, now);
    await burst(noa, dan, 49_000n, 10, 240, 30);
    now = at(280);
    expect(await job.run()).toMatchObject({ findings: 4, opened: 1, duplicate: 2, suppressed: 1 });
    expect((await cases('velocity')).map((c) => [c.payload['rule'], c.payload['partyId'], c.payload['count']])).toEqual([['velocity', noa, 30]]);
  });

  it('velocity and fan-out open for a member spraying 25 small sends to 25 members; fan-in opens for a member paid by ten; each carries its rule', async () => {
    for (let i = 0; i < 25; i++) await send(lior, uuidv7(at(300 + i)), 1_000n, at(300 + i * 50));
    for (let i = 0; i < 10; i++) await send(uuidv7(at(300 + i)), dan, 2_000n, at(300 + i * 60));
    now = at(300 + 24 * 60);
    const r = await job.run();
    expect(r).toMatchObject({ movements: 35, opened: 3, suppressed: 0 });
    const opened = (await cases('velocity')).filter((c) => c.payload['partyId'] !== noa).map((c) => [c.payload['rule'], c.payload['partyId'], c.payload['count'], c.payload['counterparties'], c.severity]);
    expect(opened).toEqual(expect.arrayContaining([
      ['velocity', lior, 25, 25, 'medium'],
      ['fan_out', lior, 25, 25, 'medium'],
      ['fan_in', dan, 10, 10, 'medium'],
    ]));
    expect(opened).toHaveLength(3);
    expect((await alerts.list()).filter((a) => a.kind === 'velocity' && a.partyId !== noa).map((a) => a.summary).sort()).toEqual([
      '25 outgoing movements, ₪250.00 in all, within 24 hours: over the movements limit (25 or ₪20,000.00)',
      'received 10 sends from 10 different members, ₪200.00 in all, within 24 hours',
      'sent 25 times to 25 different members, ₪250.00 in all, within 24 hours',
    ].sort());
    // An hour on, the lookback has slid past Lior's first send: the fan-out pattern re-anchors on the
    // second one, but the cleared case already covers those transfers, so nothing reopens.
    const fanOut = (await cases('velocity')).find((c) => c.payload['rule'] === 'fan_out')!;
    await alerts.decide(fanOut.id, 'cleared', 'Youth group reimbursements, confirmed with the institution', staff, now);
    now = at(300 + 24 * 60 + 60);
    expect(await job.run()).toMatchObject({ findings: 1, opened: 0, duplicate: 1, suppressed: 0 });
    expect((await cases('velocity')).filter((c) => c.payload['rule'] === 'fan_out')).toHaveLength(1);
    // Movements older than the lookback are not read: a day later the same purse is quiet.
    now = at(300 + 50 * 60);
    expect(await job.run()).toMatchObject({ movements: 0, findings: 0, opened: 0 });
  });

  it('with the flag off the job reads and writes nothing', async () => {
    const off = new MonitoringJob(db, new StaticFlags(), () => at(60));
    const before = (await cases()).length;
    expect(await off.run()).toMatchObject({ skipped: 'flag_off', movements: 0, findings: 0, opened: 0 });
    expect((await cases()).length).toBe(before);
  });

  it('reads allowance payments too (T-0607): 25 to one member in a day are movements, and no rule fires on them', async () => {
    const later = new Date(now.getTime() + 30 * 86_400_000);
    const member = uuidv7();
    for (let i = 0; i < 25; i++) await transfers.create({ idempotencyKey: `allowance:mon:${i.toString().padStart(3, '0')}:${member}`, kind: 'allowance', toPartyId: member, amount: money(20_000n, 'ILS') }, new Date(later.getTime() - i * 60_000));
    const before = (await cases()).length;
    expect(await new MonitoringJob(db, new StaticFlags(undefined, { [MONITORING_FLAG]: true }), () => later).run()).toMatchObject({ movements: 25, findings: 0, opened: 0 });
    expect((await cases()).length).toBe(before);
  });
});

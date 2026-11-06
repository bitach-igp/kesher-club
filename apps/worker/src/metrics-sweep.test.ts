// T-0053: the periodic gauges read the database: reconciliation breaks, webhook lag and stuck transfers. Only a state, a market and an age leave them.
import { createMetrics, uuidv7 } from '@kesher/domain';
import { InboundEventStore } from '@kesher/api/webhooks/store';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportReconBreaks } from './jobs.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
let db: TestDatabase;
const lines: Record<string, unknown>[] = [];
const metrics = createMetrics({ write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(async () => db.close());

describe('metrics sweeps (T-0053)', () => {
  it('reports no open breaks as zero', async () => {
    expect(await reportReconBreaks(db, metrics, NOW)).toEqual({ openUsdMinor: 0n, oldestHours: 0 });
    expect(lines.map((l) => l['recon.break_open_usd'] ?? l['recon.break_oldest_h'])).toEqual([0, 0]);
  });

  it('sums open USD breaks as a number from minor units and ages the oldest open case', async () => {
    const add = async (status: string, openedAt: Date, partner: bigint | null, ledger: bigint | null, currency: string, ledgerCurrency = currency) => {
      const caseId = uuidv7(openedAt);
      await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, opened_at) values ($1, 'recon_break', $4, 'medium', $2, $3)`, [caseId, status, openedAt, `dk-${caseId}`]);
      await db.query(
        `insert into ops.recon_break (id, case_id, provider, external_id, partner_minor, partner_currency, ledger_minor, ledger_currency, reason, run_date) values ($1, $2, 'p', $6, $3, $5, $4, $7, 'amount_mismatch', '2026-11-05')`,
        [uuidv7(openedAt), caseId, partner?.toString() ?? null, ledger?.toString() ?? null, currency, `ext-${caseId}`, ledgerCurrency],
      );
    };
    await add('open', hoursAgo(30), 10_000n, 7_500n, 'USD'); // 25.00
    await add('investigating', hoursAgo(2), null, 3_005n, 'USD'); // 30.05
    await add('open', hoursAgo(50), 99_999n, 0n, 'ILS'); // another currency: aged, not summed
    await add('resolved', hoursAgo(100), 90_000n, 0n, 'USD'); // closed: ignored
    await add('open', hoursAgo(5), 70_000n, 70_000n, 'USD', 'ILS'); // USD against ILS: never subtracted, left out of the USD figure
    // US banking recon (apps/worker/src/recon/us-banking.ts) opens a case with the amounts in the payload and no ops.recon_break row.
    const us = async (payload: unknown, openedAt: Date) => db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'recon_break', $2, 'medium', 'open', $3, $4)`, [uuidv7(openedAt), `us-${uuidv7()}`, JSON.stringify(payload), openedAt]);
    await us({ provider: 'crowded', externalId: 'pay-1', reason: 'payment_without_page', amount: { minor: '2000', currency: 'USD' } }, hoursAgo(60)); // 20.00
    await us({ externalId: 'pay-2', reason: 'amount_mismatch', day: '2026-11-04', provider: { minor: '1000', currency: 'USD' }, recorded: { minor: '400', currency: 'USD' } }, hoursAgo(3)); // 6.00
    await us({ reason: 'deadline_missed', day: '2026-11-04' }, hoursAgo(1)); // no amount: counts toward age only (in the real payload `provider` holds the provider's amount on a mismatch, as here)
    lines.length = 0;
    expect(await reportReconBreaks(db, metrics, NOW)).toEqual({ openUsdMinor: 8_105n, oldestHours: 60 });
    expect(lines.map((l) => l['recon.break_open_usd'] ?? l['recon.break_oldest_h'])).toEqual([81.05, 60]);
    expect(lines[0]).not.toHaveProperty('job');
  });

  it('webhook.lag_s is the age of the oldest unapplied event, per market', async () => {
    const store = new InboundEventStore(db, 'IL', metrics);
    lines.length = 0;
    await store.reportLag(NOW);
    expect(lines.at(-1)).toMatchObject({ market: 'IL', 'webhook.lag_s': 0 });
    await store.record({ provider: 'p', eventId: 'evt-00000001', signatureOk: true, payload: {}, receivedAt: new Date(NOW.getTime() - 90_000) });
    await store.reportLag(NOW);
    expect(lines.at(-1)).toMatchObject({ market: 'IL', 'webhook.lag_s': 90 });
  });

  it('transfer.stuck{state} is the age of the oldest non-terminal transfer in each state, and no id', async () => {
    const t = new TransferService(db, 'IL', metrics);
    const seed = (id: string, state: string, at: Date) =>
      db.query(`insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state, market, created_at, updated_at) values ($1, $2, 'p2p', $1, 100, 'USD', $3, 'IL', $4, $4)`, [id, `key-${id}`, state, at]);
    await seed(uuidv7(), 'pending', new Date(NOW.getTime() - 600_000));
    await seed(uuidv7(), 'pending', new Date(NOW.getTime() - 60_000));
    await seed(uuidv7(), 'settled', hoursAgo(99));
    lines.length = 0;
    expect(await t.reportStuck(NOW)).toEqual([{ state: 'pending', ageS: 600 }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ state: 'pending', market: 'IL', 'transfer.stuck': 600 });
    expect(Object.keys(lines[0]!).sort()).toEqual(['_aws', 'market', 'state', 'transfer.stuck']);
  });
});

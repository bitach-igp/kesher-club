// RefreshRatesJob (T-0513, REQ-FX-003/004). TST-FX-004: the job publishes the port's mid as a club rate
// valid for 15 minutes and supersedes it on the next run; an active manual rate stops it; a port outage
// publishes nothing, is reported, and the old rate simply runs out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { FxError, FxSimulator, fixedClock, type FxPort } from '@kesher/ports';
import { ApprovalService } from '@kesher/api/approvals/service';
import { AuditService } from '@kesher/api/audit/service';
import { PORT_RATE_TTL_MS, RateService } from '@kesher/api/fx/rates';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { REFRESH_CYCLE_MS, RefreshRatesJob } from './refresh-rates.ts';

let db: TestDatabase;
let rates: RateService;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
const at = (ms: number) => new Date(NOW.getTime() + ms);

beforeAll(async () => {
  db = await createTestDatabase();
  rates = new RateService(db, new ApprovalService(db), new AuditService(db));
}, 60_000);
afterAll(async () => db.close());

describe('TST-FX-004: the refresh job', () => {
  it('publishes the port mid for 15 minutes, supersedes it on the next cycle, and reports what it did', async () => {
    const job = new RefreshRatesJob(new FxSimulator(fixedClock(NOW.toISOString())), rates, () => now);
    expect(await job.run()).toEqual({ ranAt: NOW.toISOString(), published: [{ pair: 'USD/ILS', version: 1, mid: '3.710000' }], manual: [], errors: [] });
    expect(await rates.current('USD/ILS', now)).toMatchObject({ version: 1, source: 'port', midScaled: 3_710_000n, validUntil: at(PORT_RATE_TTL_MS).toISOString() });
    now = at(REFRESH_CYCLE_MS);
    expect((await job.run()).published).toEqual([{ pair: 'USD/ILS', version: 2, mid: '3.710000' }]);
    expect((await rates.history('USD/ILS')).map((r) => [r.version, r.status])).toEqual([
      [2, 'active'],
      [1, 'superseded'],
    ]);
    expect(REFRESH_CYCLE_MS * 3).toBe(PORT_RATE_TTL_MS); // three refreshes fit one window: one miss is survivable
  });

  it('a port outage publishes nothing and is reported; the last rate runs out on its own', async () => {
    const down: FxPort = {
      quote: async () => {
        throw new FxError('PROVIDER_UNAVAILABLE', 'Simulated FX outage');
      },
      convert: async () => {
        throw new FxError('PROVIDER_UNAVAILABLE', 'Simulated FX outage');
      },
    };
    now = at(2 * REFRESH_CYCLE_MS);
    const report = await new RefreshRatesJob(down, rates, () => now).run();
    expect(report).toMatchObject({ published: [], manual: [], errors: [{ pair: 'USD/ILS', error: 'Simulated FX outage' }] });
    expect((await rates.current('USD/ILS', now))?.version).toBe(2);
    now = at(REFRESH_CYCLE_MS + PORT_RATE_TTL_MS);
    expect(await rates.current('USD/ILS', now)).toBeUndefined();
  });

  it('an active manual rate stops the job from publishing', async () => {
    const fin = { partyId: uuidv7(now), role: 'finance', subject: 'auth0|finance-a' };
    const p = await rates.propose('USD/ILS', 3_700_000n, fin, 'Fixing', now);
    await rates.approve(p.rate.id, { partyId: uuidv7(now), role: 'finance' }, now);
    const job = new RefreshRatesJob(new FxSimulator(fixedClock(now.toISOString())), rates, () => now);
    expect(await job.run()).toMatchObject({ published: [], manual: ['USD/ILS'], errors: [] });
    expect(await rates.current('USD/ILS', now)).toMatchObject({ version: p.rate.version, source: 'manual' });
  });
});

describe('T-0546: the job reports a refused mid', () => {
  it('a decimal-slip mid (10x) is refused and reported, not published: the old rate stays, a case is opened, then the old rate runs out', async () => {
    const db2 = await createTestDatabase();
    try {
      const r = new RateService(db2, new ApprovalService(db2), new AuditService(db2));
      let t = NOW;
      await new RefreshRatesJob(new FxSimulator(fixedClock(NOW.toISOString())), r, () => t).run();
      const slipped: FxPort = {
        quote: async (input) => ({ quoteId: 'slip', from: input.from, to: input.to, rateScaled: 37_000_000n, total: input.from }) as never,
        convert: async () => {
          throw new FxError('PROVIDER_UNAVAILABLE', 'unused');
        },
      };
      t = at(5 * 60_000);
      const report = await new RefreshRatesJob(slipped, r, () => t).run();
      expect(report).toMatchObject({ published: [], manual: [], errors: [{ pair: 'USD/ILS', error: expect.stringContaining('moved') }] });
      expect((await r.history('USD/ILS')).map((x) => x.version)).toEqual([1]);
      expect((await r.current('USD/ILS', t))?.midScaled).toBe(3_710_000n);
      expect((await db2.query<{ n: number }>(`select count(*)::int as n from ops.case where kind = 'fx_rate_deviation'`)).rows[0]!.n).toBe(1);
      await expect(r.rateFor('USD', 'ILS', at(16 * 60_000))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    } finally {
      await db2.close();
    }
  }, 60_000);
});


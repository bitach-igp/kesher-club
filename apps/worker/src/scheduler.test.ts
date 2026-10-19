import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daily, type DailyJob, israelClock, type Job, type JobLock, noLock, type RunLog, Scheduler } from './scheduler.ts';

type Line = { event: string; fields: Record<string, string | number | boolean> };

function recorder(): { log: (event: string, fields: Line['fields']) => void; lines: Line[] } {
  const lines: Line[] = [];
  return { lines, log: (event, fields) => lines.push({ event, fields }) };
}

/** A job that counts its runs and takes `takesMs` of fake time each. */
function countingJob(name: string, everyMs: number, takesMs = 0): Job & { runs: number[] } {
  const runs: number[] = [];
  return {
    name,
    scope: 'market',
    everyMs,
    runs,
    run: async () => {
      runs.push(Date.now());
      if (takesMs > 0) await new Promise((r) => setTimeout(r, takesMs));
    },
  };
}

/** stop() waits for in-flight runs, which wait on the fake clock: move it while stopping. */
async function stopAdvancing(s: Scheduler, ms: number): Promise<void> {
  const stopping = s.stop();
  await vi.advanceTimersByTimeAsync(ms);
  await stopping;
}

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('runs every job at boot and then once per cycle', async () => {
    const fast = countingJob('fast', 30_000);
    const slow = countingJob('slow', 60_000);
    const s = new Scheduler([fast, slow], noLock, recorder().log);
    s.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fast.runs).toEqual([0, 30_000, 60_000, 90_000, 120_000]);
    expect(slow.runs).toEqual([0, 60_000, 120_000]);
    await s.stop();
  });

  it('never overlaps a run that outlasts its cycle; the next starts when it ends', async () => {
    let running = 0;
    let most = 0;
    const starts: number[] = [];
    const long: Job = {
      name: 'long',
      scope: 'market',
      everyMs: 10_000,
      run: async () => {
        starts.push(Date.now());
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 25_000));
        running -= 1;
      },
    };
    const s = new Scheduler([long], noLock, recorder().log);
    s.start();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(most).toBe(1);
    expect(starts).toHaveLength(4);
    // Each run starts as the last ends (Node clamps the 0 ms timer to 1 ms).
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeOneOf([25_000, 25_001]);
    await stopAdvancing(s, 25_000);
  });

  it('times the next run from the end of the last', async () => {
    const job = countingJob('steady', 60_000, 20_000);
    const s = new Scheduler([job], noLock, recorder().log);
    s.start();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(job.runs).toEqual([0, 60_000, 120_000]);
    await stopAdvancing(s, 20_000);
  });

  it('logs a failing run by name, error class and code only, and runs it again next cycle', async () => {
    const secret = 'member 4111111111111111 otp 123456 token eyJhbGciOi';
    let calls = 0;
    const flaky: Job = {
      name: 'flaky',
      scope: 'market',
      everyMs: 30_000,
      run: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new TypeError(secret), { code: 'PROVIDER_UNAVAILABLE', payload: { pan: secret } });
      },
    };
    const other = countingJob('other', 30_000);
    const { log, lines } = recorder();
    const s = new Scheduler([flaky, other], noLock, log);
    s.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const failed = lines.filter((l) => l.event === 'job_failed');
    expect(failed).toEqual([{ event: 'job_failed', fields: { job: 'flaky', ms: 0, error: 'TypeError', code: 'PROVIDER_UNAVAILABLE' } }]);
    expect(JSON.stringify(lines)).not.toContain('4111');
    expect(JSON.stringify(lines)).not.toContain('eyJ');
    expect(calls).toBe(2);
    expect(other.runs).toEqual([0, 30_000]);
    expect(lines.filter((l) => l.event === 'job_ran' && l.fields['job'] === 'flaky')).toHaveLength(1);
    await s.stop();
  });

  it('logs a thrown non-Error by its type, without its value', async () => {
    const odd: Job = { name: 'odd', scope: 'market', everyMs: 1_000, run: () => Promise.reject('sk_live_abc') };
    const { log, lines } = recorder();
    const s = new Scheduler([odd], noLock, log);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await s.stop();
    expect(lines).toEqual([{ event: 'job_failed', fields: { job: 'odd', ms: 0, error: 'string' } }]);
  });

  it('skips, and does not queue, a run whose lock another task holds', async () => {
    const held = new Set(['busy']);
    const lock: JobLock = {
      withLock: async (job, fn) => (held.has(job.name) ? { ran: false } : { ran: true, value: await fn() }),
    };
    const busy = countingJob('busy', 10_000);
    const { log, lines } = recorder();
    const s = new Scheduler([busy], lock, log);
    s.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(busy.runs).toEqual([]);
    expect(lines.map((l) => l.event)).toEqual(['job_skipped', 'job_skipped', 'job_skipped']);

    held.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(busy.runs).toEqual([30_000]);
    await s.stop();
  });

  it('stop() lets an in-flight run finish and schedules nothing more', async () => {
    const job = countingJob('drain', 10_000, 5_000);
    const { log, lines } = recorder();
    const s = new Scheduler([job], noLock, log);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);

    let stopped = false;
    const stopping = s.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    await stopping;
    expect(lines).toEqual([{ event: 'job_ran', fields: { job: 'drain', ms: 5_000 } }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.runs).toEqual([0]);
  });

  it('stop() before a pending run cancels it', async () => {
    const job = countingJob('pending', 10_000);
    const s = new Scheduler([job], noLock, recorder().log);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.runs).toEqual([0]);
  });

  it('refuses two jobs with one name and a cycle that is not positive', () => {
    const a = countingJob('a', 1_000);
    expect(() => new Scheduler([a, countingJob('a', 2_000)], noLock, recorder().log)).toThrow(/Two jobs are named a/);
    expect(() => new Scheduler([countingJob('z', 0)], noLock, recorder().log)).toThrow(/positive cycle/);
    expect(() => new Scheduler([countingJob('n', Number.NaN)], noLock, recorder().log)).toThrow(/positive cycle/);
  });
});

/** ops.job_run in memory: one row per job and Israel day. */
function memoryRuns(): RunLog & { rows: Map<string, { started: string; finished: string }> } {
  const rows = new Map<string, { started: string; finished: string }>();
  return {
    rows,
    ranOn: async (job, day) => rows.has(`${job}@${day}`),
    record: async (job, day, startedAt, finishedAt) => void rows.set(`${job}@${day}`, { started: startedAt.toISOString(), finished: finishedAt.toISOString() }),
  };
}

const nightly = (at: string, body: (now: Date) => Promise<unknown> = async () => 'ok'): DailyJob & { runs: string[] } => {
  const runs: string[] = [];
  return {
    name: 'balance-proof',
    scope: 'club',
    at,
    runs,
    run: async (now) => {
      runs.push(now.toISOString());
      return body(now);
    },
  };
};

describe('daily jobs at Israel wall-clock times (T-0023)', () => {
  afterEach(() => vi.useRealTimers());
  const now = () => new Date();

  async function runFor(startIso: string, hours: number, job: DailyJob, runs: RunLog, log = recorder().log): Promise<void> {
    vi.useFakeTimers({ now: new Date(startIso) });
    const s = new Scheduler([daily(job, runs, now)], noLock, log);
    s.start();
    await vi.advanceTimersByTimeAsync(hours * 3_600_000);
    await s.stop();
  }

  it('runs once per Israel day at its time, and records the day it belongs to', async () => {
    const job = nightly('02:30');
    const runs = memoryRuns();
    await runFor('2026-10-19T21:30:00Z', 72, job, runs); // 00:30 on 20 Oct in Israel (UTC+3)
    expect(job.runs).toEqual(['2026-10-19T23:30:00.000Z', '2026-10-20T23:30:00.000Z', '2026-10-21T23:30:00.000Z']);
    expect([...runs.rows.keys()]).toEqual(['balance-proof@2026-10-20', 'balance-proof@2026-10-21', 'balance-proof@2026-10-22']);
  });

  it('runs once on the night the clocks go back, though 01:00 to 02:00 happens twice', async () => {
    const job = nightly('01:30');
    await runFor('2026-10-24T21:30:00Z', 12, job, memoryRuns()); // 00:30 on 25 Oct 2026, the night 02:00 IDT becomes 01:00 IST
    expect(job.runs).toEqual(['2026-10-24T22:30:00.000Z']);
  });

  it('runs at the first tick after the clocks jump forward past its time', async () => {
    const job = nightly('02:30');
    await runFor('2027-03-25T22:30:00Z', 8, job, memoryRuns()); // 00:30 on 26 Mar 2027, the night 02:00 IST becomes 03:00 IDT: 02:30 never happens
    expect(job.runs).toEqual(['2027-03-26T00:00:00.000Z']);
    expect(israelClock(new Date('2027-03-26T00:00:00Z'))).toEqual({ day: '2027-03-26', time: '03:00' });
  });

  it('runs once when the worker boots after its time with no run recorded today, and not again after a restart', async () => {
    const runs = memoryRuns();
    const first = nightly('02:30');
    await runFor('2026-10-19T09:00:00Z', 1, first, runs); // noon in Israel
    expect(first.runs).toEqual(['2026-10-19T09:00:00.000Z']);

    const restarted = nightly('02:30');
    await runFor('2026-10-19T10:00:00Z', 6, restarted, runs);
    expect(restarted.runs).toEqual([]);
  });

  it('a failed run records nothing, is logged, and runs again at the next tick', async () => {
    let calls = 0;
    const job = nightly('02:30', async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('statement timeout'), { code: '57014' });
      return 'ok';
    });
    const runs = memoryRuns();
    const { log, lines } = recorder();
    await runFor('2026-10-19T23:29:00Z', 2, job, runs, log);
    expect(job.runs).toEqual(['2026-10-19T23:30:00.000Z', '2026-10-19T23:31:00.000Z']);
    expect(lines.map((l) => l.event)).toEqual(['job_failed', 'job_ran']);
    expect(lines[0]!.fields).toMatchObject({ job: 'balance-proof', error: 'Error', code: '57014' });
    expect([...runs.rows.keys()]).toEqual(['balance-proof@2026-10-20']);
  });

  it('logs nothing for the ticks before its time or after its run', async () => {
    const { log, lines } = recorder();
    await runFor('2026-10-19T09:00:00Z', 3, nightly('23:59'), memoryRuns(), log);
    expect(lines).toEqual([]);
  });

  it('refuses a time that is not HH:MM', () => {
    for (const at of ['2:30', '24:00', '02:60', '0230']) expect(() => daily(nightly(at), memoryRuns(), now)).toThrow(/HH:MM/);
  });
});

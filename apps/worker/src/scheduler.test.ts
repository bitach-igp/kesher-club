import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Job, type JobLock, noLock, Scheduler } from './scheduler.ts';

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
    const odd: Job = { name: 'odd', everyMs: 1_000, run: () => Promise.reject('sk_live_abc') };
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
      withLock: async (name, fn) => (held.has(name) ? { ran: false } : { ran: true, value: await fn() }),
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

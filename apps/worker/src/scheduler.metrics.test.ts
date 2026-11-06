// T-0053: the scheduler emits job.failure and job.age_s, and a broken emitter cannot stop a job's next cycle.
import { createMetrics, type Metrics } from '@kesher/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE, type Job, noLock, Scheduler } from './scheduler.ts';

const lines: Record<string, unknown>[] = [];
const metrics = () => createMetrics({ write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
const job = (name: string, run: Job['run']): Job => ({ name, scope: 'market', everyMs: 60_000, run });

describe('Scheduler metrics', () => {
  beforeEach(() => {
    lines.length = 0;
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it('a failing job emits job.failure{job} and an age since its last success', async () => {
    let fail = false;
    const s = new Scheduler([job('load-sweep', async () => { if (fail) throw new Error('x'); })], noLock, () => undefined, metrics());
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.filter((l) => 'job.age_s' in l)).toEqual([expect.objectContaining({ job: 'load-sweep', 'job.age_s': 0 })]);
    fail = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const failures = lines.filter((l) => 'job.failure' in l);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ job: 'load-sweep', 'job.failure': 1 });
    expect(lines.filter((l) => 'job.age_s' in l).map((l) => l['job.age_s'])).toEqual([0, 60, 120]);
    await vi.advanceTimersByTimeAsync(0);
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
  });

  it('emits nothing for a skipped tick or an idle daily tick', async () => {
    const lock = { withLock: async () => ({ ran: false as const }) };
    const s = new Scheduler([job('a', async () => undefined)], lock, () => undefined, metrics());
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await s.stop();
    const idle = new Scheduler([job('b', async () => IDLE)], noLock, () => undefined, metrics());
    idle.start();
    await vi.advanceTimersByTimeAsync(0);
    await idle.stop();
    expect(lines).toEqual([]);
  });

  it('a failing emitter does not stop the job from running again', async () => {
    const broken = new Proxy({}, { get: () => () => { throw new Error('emitter down'); } }) as unknown as Metrics;
    let runs = 0;
    const s = new Scheduler([job('j', async () => { runs += 1; throw new Error('x'); })], noLock, () => undefined, broken);
    s.start();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(runs).toBe(3);
    await s.stop();
  });
});

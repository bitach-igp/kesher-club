// The worker's plain scheduler (T-0022, ADR-002: "the plain scheduler until then"). Each job runs at
// boot and then once per cycle, never overlapping itself: the next run is timed from the end of the
// last, and a run longer than its cycle is followed by the next at once. A job that throws is logged
// (its name, the error's name and code; never a payload, a member's data or a token) and runs again
// next cycle; the other jobs carry on. One runner per job across worker tasks: each run first takes a
// lock named after the job and is skipped, not queued, when another task holds it. stop() lets in-flight
// runs finish and schedules nothing more. The job bodies are the same ones Temporal will host.

export interface Job {
  /** Stable name: the lock key and the log label. */
  name: string;
  /** Time from the end of one run to the start of the next. */
  everyMs: number;
  run(): Promise<unknown>;
}

export interface JobLock {
  /** Runs `fn` while holding the lock named `name`; resolves `{ ran: false }` without running it when another holder has it. */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
}

export type Log = (event: string, fields: Record<string, string | number | boolean>) => void;

/** Error identity safe to log: the class name and a code if it carries one, never the message or a payload. */
export function errorFields(e: unknown): Record<string, string> {
  const name = e instanceof Error ? e.name : typeof e;
  const code = typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined;
  return { error: name, ...(code ? { code } : {}) };
}

export class Scheduler {
  private readonly jobs: readonly Job[];
  private readonly lock: JobLock;
  private readonly log: Log;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(jobs: readonly Job[], lock: JobLock, log: Log) {
    const names = new Set<string>();
    for (const j of jobs) {
      if (names.has(j.name)) throw new Error(`Two jobs are named ${j.name}`);
      if (!(j.everyMs > 0)) throw new Error(`Job ${j.name} needs a positive cycle`);
      names.add(j.name);
    }
    this.jobs = jobs;
    this.lock = lock;
    this.log = log;
  }

  start(): void {
    for (const job of this.jobs) this.schedule(job, 0);
  }

  /** No new runs; resolves when every run already started has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.all([...this.inFlight]);
  }

  private schedule(job: Job, delayMs: number): void {
    if (this.stopped) return;
    this.timers.set(
      job.name,
      setTimeout(() => {
        this.timers.delete(job.name);
        const run = this.runOnce(job);
        this.inFlight.add(run);
        void run.finally(() => this.inFlight.delete(run));
      }, delayMs),
    );
  }

  private async runOnce(job: Job): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await this.lock.withLock(job.name, () => job.run());
      this.log(outcome.ran ? 'job_ran' : 'job_skipped', { job: job.name, ms: Date.now() - started });
    } catch (e) {
      this.log('job_failed', { job: job.name, ms: Date.now() - started, ...errorFields(e) });
    }
    this.schedule(job, Math.max(0, job.everyMs - (Date.now() - started)));
  }
}

/** A lock that always grants: for a single worker and for tests. */
export const noLock: JobLock = { withLock: async (_name, fn) => ({ ran: true, value: await fn() }) };

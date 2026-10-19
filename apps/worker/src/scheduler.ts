// The worker's plain scheduler (T-0022, ADR-002: "the plain scheduler until then"). Each job runs at
// boot and then once per cycle, never overlapping itself: the next run is timed from the end of the
// last, and a run longer than its cycle is followed by the next at once. A job that throws is logged
// (its name, the error's name and code; never a payload, a member's data or a token) and runs again
// next cycle; the other jobs carry on. One runner per job across worker tasks: each run first takes a
// lock named after the job and is skipped, not queued, when another task holds it. stop() lets in-flight
// runs finish and schedules nothing more. The job bodies are the same ones Temporal will host. Nightly
// jobs ride the same loop through `daily()` below.

/**
 * Who may run a job at once (T-0028). A `market` job sweeps rows that carry its worker's market and
 * calls that market's providers, so each market's worker runs its own, side by side. A `club` job's
 * work is not split by market (the club rate, monitoring, the balance proof, tables with no market),
 * so one lock spans the club and two workers never run it at the same time.
 */
export type JobScope = 'market' | 'club';

export interface Job {
  /** Stable name: the lock key and the log label. */
  name: string;
  scope: JobScope;
  /** Time from the end of one run to the start of the next. */
  everyMs: number;
  run(): Promise<unknown>;
}

export interface JobLock {
  /** Runs `fn` while holding the job's lock; resolves `{ ran: false }` without running it when another holder has it. */
  withLock<T>(job: Pick<Job, 'name' | 'scope'>, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
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
      const outcome = await this.lock.withLock(job, () => job.run());
      // A daily job's tick before its time, or after today's run, is not news.
      if (!(outcome.ran && outcome.value === IDLE)) this.log(outcome.ran ? 'job_ran' : 'job_skipped', { job: job.name, ms: Date.now() - started });
    } catch (e) {
      this.log('job_failed', { job: job.name, ms: Date.now() - started, ...errorFields(e) });
    }
    this.schedule(job, Math.max(0, job.everyMs - (Date.now() - started)));
  }
}

/** What a run returns when it had nothing to do; the scheduler logs nothing for it. */
export const IDLE: unique symbol = Symbol('idle');

// ---- nightly jobs (T-0023) ------------------------------------------------------------------------
// A daily job is an ordinary job that ticks every minute: it runs once the Israel wall-clock time has
// reached its slot and no run is recorded for today's Israel date, and it records the run when it
// finishes. So a worker that boots late runs it once, a restart the same day does not run it again, a
// failure records nothing and the next tick retries it, and DST needs no special case: on the night the
// clocks jump forward past the slot, the first tick after the jump is already past it.

export const ISRAEL_TZ = 'Asia/Jerusalem';
export const DAILY_TICK_MS = 60_000;

export interface RunLog {
  ranOn(job: string, day: string): Promise<boolean>;
  record(job: string, day: string, startedAt: Date, finishedAt: Date): Promise<void>;
}

export interface DailyJob {
  name: string;
  scope: JobScope;
  /** Israel wall-clock time, `HH:MM`. */
  at: string;
  run(now: Date): Promise<unknown>;
}

const israelParts = new Intl.DateTimeFormat('en-CA', { timeZone: ISRAEL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The Israel calendar day (`YYYY-MM-DD`) and wall-clock time (`HH:MM`) at `now`. */
export function israelClock(now: Date): { day: string; time: string } {
  const p = Object.fromEntries(israelParts.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p['year']}-${p['month']}-${p['day']}`, time: `${p['hour']}:${p['minute']}` };
}

export function daily(job: DailyJob, runs: RunLog, clock: () => Date): Job {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(job.at)) throw new Error(`Job ${job.name} needs an HH:MM time, not ${job.at}`);
  return {
    name: job.name,
    scope: job.scope,
    everyMs: DAILY_TICK_MS,
    run: async () => {
      const started = clock();
      const { day, time } = israelClock(started);
      if (time < job.at || (await runs.ranOn(job.name, day))) return IDLE;
      const value = await job.run(started);
      await runs.record(job.name, day, started, clock());
      return value;
    },
  };
}

/** A lock that always grants: for a single worker and for tests. */
export const noLock: JobLock = { withLock: async (_job, fn) => ({ ran: true, value: await fn() }) };

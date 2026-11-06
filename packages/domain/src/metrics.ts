// Application metrics as CloudWatch Embedded Metric Format lines (T-0053). One JSON object per line on stdout; CloudWatch Logs
// turns the `_aws` block into metrics, so there is no agent, no SDK call, no network and no new dependency, and nothing on the
// authorisation path waits on anything. These are the series the runbooks alert on (docs/runbooks/README.md, "Alerts that page").
//
// Three rules hold by construction, like the logger's redaction (log.ts):
//  - Dimensions are a CLOSED set (market, port, job, state). A metric names the dimensions it may carry; anything else is dropped
//    with the whole line, and `validateDimensions` throws for it so a test fails. A dimension value is a short identifier or a
//    member of a fixed list, never an id: a member, account or transfer id cannot become a dimension, because the value that
//    would carry it is refused. High-cardinality dimensions are a bill and a leak.
//  - Emitting never throws and never blocks: the default sink is one synchronous stdout write inside try/catch, and `guarded`
//    wraps any injected emitter the same way. A failing emitter must never change a JIT decision, a job or a transfer.
//  - Values are plain numbers for monitoring, not money. `recon.break_open_usd` is whole dollars as a number made from bigint
//    minor units with `minorToNumber`; it is read by an alarm and never added to a ledger, converted or paid out.

/** The closed set of metric dimensions. */
export const METRIC_DIMENSIONS = ['market', 'port', 'job', 'state'] as const;
export type MetricDimension = (typeof METRIC_DIMENSIONS)[number];
export type MetricUnit = 'Count' | 'Milliseconds' | 'Seconds' | 'Hours' | 'None';

export const METRICS_NAMESPACE = 'Kesher';

/** Every metric, its unit and the dimensions it carries. The runbook alarms (T-0054) match these exactly. */
export const METRIC_DEFS = {
  'jit.decision_ms': { unit: 'Milliseconds', dimensions: [] },
  'jit.error': { unit: 'Count', dimensions: [] },
  'webhook.lag_s': { unit: 'Seconds', dimensions: ['market'] },
  'job.failure': { unit: 'Count', dimensions: ['job'] },
  'job.age_s': { unit: 'Seconds', dimensions: ['job'] },
  'recon.break_open_usd': { unit: 'None', dimensions: [] },
  'recon.break_oldest_h': { unit: 'Hours', dimensions: [] },
  'transfer.stuck': { unit: 'Seconds', dimensions: ['state', 'market'] },
  'provider.error': { unit: 'Count', dimensions: ['port'] },
} as const satisfies Record<string, { unit: MetricUnit; dimensions: readonly MetricDimension[] }>;
export type MetricName = keyof typeof METRIC_DEFS;

export type Dimensions = Partial<Record<MetricDimension, string>>;

const STATES: ReadonlySet<string> = new Set(['created', 'submitted', 'pending', 'pending_hold', 'settled', 'failed', 'reversed', 'cancelled']);
const MARKETS: ReadonlySet<string> = new Set(['IL', 'US']);
/** A port or job name: a short lower-case identifier. A UUID or any long hex or digit run is an id, not a name. */
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const LOOKS_LIKE_ID = /[0-9a-f]{8}-?[0-9a-f]{4}|\d{6,}/i;

/** Throws when `dimensions` names a dimension outside the closed set, or a value that is not a bounded name. */
export function validateDimensions(dimensions: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(dimensions)) {
    if (!(METRIC_DIMENSIONS as readonly string[]).includes(name)) throw new Error(`Unknown metric dimension ${name}`);
    if (typeof value !== 'string') throw new Error(`Metric dimension ${name} needs a string`);
    const ok = name === 'market' ? MARKETS.has(value) : name === 'state' ? STATES.has(value) : NAME.test(value) && !LOOKS_LIKE_ID.test(value);
    if (!ok) throw new Error(`Metric dimension ${name} is not a bounded name`);
  }
}

/** Whole units as a number from bigint minor units, for monitoring only: 12_345n at exponent 2 is 123.45. Never feed it back into money. */
export function minorToNumber(minor: bigint, exponent = 2): number {
  const unit = 10n ** BigInt(exponent);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const n = Number(abs / unit) + Number(abs % unit) / Number(unit);
  return negative ? -n : n;
}

export interface MetricsOptions {
  /** The sink; stdout by default. Receives one line without the newline. */
  write?: (line: string) => void;
  now?: () => Date;
  namespace?: string;
}

export interface Metrics {
  /** One line, one or more metrics sharing one dimension set. Never throws. */
  put(values: Partial<Record<MetricName, number>>, dimensions?: Dimensions): void;
  jitDecision(ms: number, error: boolean): void;
  webhookLag(seconds: number, market: string): void;
  jobFailure(job: string): void;
  jobAge(job: string, seconds: number): void;
  reconBreakOpenUsd(dollars: number): void;
  reconBreakOldestHours(hours: number): void;
  transferStuck(state: string, market: string, seconds: number): void;
  providerError(port: string): void;
}

function build(put: Metrics['put']): Metrics {
  return {
    put,
    jitDecision: (ms, error) => put({ 'jit.decision_ms': ms, 'jit.error': error ? 1 : 0 }),
    webhookLag: (seconds, market) => put({ 'webhook.lag_s': seconds }, { market }),
    jobFailure: (job) => put({ 'job.failure': 1 }, { job }),
    jobAge: (job, seconds) => put({ 'job.age_s': seconds }, { job }),
    reconBreakOpenUsd: (dollars) => put({ 'recon.break_open_usd': dollars }),
    reconBreakOldestHours: (hours) => put({ 'recon.break_oldest_h': hours }),
    transferStuck: (state, market, seconds) => put({ 'transfer.stuck': seconds }, { state, market }),
    providerError: (port) => put({ 'provider.error': 1 }, { port }),
  };
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const namespace = options.namespace ?? METRICS_NAMESPACE;
  return build((values, dimensions = {}) => {
    try {
      validateDimensions(dimensions);
      const entries = Object.entries(values).filter((e): e is [MetricName, number] => e[0] in METRIC_DEFS && typeof e[1] === 'number' && Number.isFinite(e[1]));
      if (entries.length === 0) return;
      const keys = Object.keys(dimensions);
      // A metric carries only the dimensions it names; a line that mixes in another is dropped, not trimmed.
      if (entries.some(([name]) => !(METRIC_DEFS[name].dimensions as readonly string[]).every((d) => keys.includes(d)) || keys.some((k) => !(METRIC_DEFS[name].dimensions as readonly string[]).includes(k)))) return;
      write(
        JSON.stringify({
          _aws: { Timestamp: now().getTime(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [keys], Metrics: entries.map(([name]) => ({ Name: name, Unit: METRIC_DEFS[name].unit })) }] },
          ...dimensions,
          ...Object.fromEntries(entries),
        }),
      );
    } catch {
      // Monitoring is best effort: a bad line or a broken sink is lost, never raised.
    }
  });
}

/** The same emitter with every method wrapped so that nothing an injected emitter does (a throw, a missing method) can reach the caller. */
export function guarded(inner: Metrics): Metrics {
  const names = Object.keys(build(() => undefined));
  const safe = Object.fromEntries(
    names.map((k) => [
      k,
      (...a: unknown[]): void => {
        try {
          (inner as unknown as Record<string, ((...x: unknown[]) => void) | undefined>)[k]?.(...a);
        } catch {
          // monitoring never raises
        }
      },
    ]),
  );
  return safe as unknown as Metrics;
}

/** The process-wide default: stdout. */
export const stdoutMetrics: Metrics = createMetrics();

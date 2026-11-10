// T-0053: metrics as CloudWatch Embedded Metric Format lines. The dimension set is closed, a line never carries an id, and a
// broken emitter or sink raises nothing.
import { describe, expect, it } from 'vitest';
import { createMetrics, guarded, METRIC_DEFS, METRIC_DIMENSIONS, minorToNumber, validateDimensions, webhookRejectReason, type Metrics } from './metrics.ts';

const capture = () => {
  const lines: string[] = [];
  const metrics = createMetrics({ write: (l) => lines.push(l), now: () => new Date('2026-11-05T12:00:00Z') });
  return { metrics, lines, last: () => JSON.parse(lines.at(-1)!) as Record<string, unknown> & { _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] } } };
};

describe('the EMF line', () => {
  it('is one JSON object with the _aws block, the dimension values and the metric values', () => {
    const { metrics, lines, last } = capture();
    metrics.jobFailure('load-sweep');
    expect(lines).toHaveLength(1);
    expect(last()).toEqual({
      _aws: { Timestamp: Date.parse('2026-11-05T12:00:00Z'), CloudWatchMetrics: [{ Namespace: 'Kesher', Dimensions: [['job']], Metrics: [{ Name: 'job.failure', Unit: 'Count' }] }] },
      job: 'load-sweep',
      'job.failure': 1,
    });
  });

  it('carries the JIT duration and the error flag on one line, with no dimensions', () => {
    const { metrics, last } = capture();
    metrics.jitDecision(12.5, false);
    expect(last()).toMatchObject({ 'jit.decision_ms': 12.5, 'jit.error': 0 });
    expect(last()._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([[]]);
    expect(last()._aws.CloudWatchMetrics[0]!.Metrics.map((m) => m.Name)).toEqual(['jit.decision_ms', 'jit.error']);
  });

  it('emits every metric the runbooks alert on, each with its declared dimensions', () => {
    const { metrics, lines } = capture();
    metrics.jitDecision(1, true);
    metrics.webhookLag(3, 'IL');
    metrics.jobFailure('monitoring');
    metrics.jobAge('monitoring', 90);
    metrics.reconBreakOpenUsd(51.25);
    metrics.reconBreakOldestHours(25);
    metrics.transferStuck('pending', 'US', 600);
    metrics.providerError('card-issuing');
    metrics.webhookRejected('stripe', 'bad_signature');
    const emitted = lines.flatMap((l) => (JSON.parse(l) as { _aws: { CloudWatchMetrics: { Metrics: { Name: string }[] }[] } })._aws.CloudWatchMetrics[0]!.Metrics.map((m) => m.Name));
    expect(emitted.sort()).toEqual(Object.keys(METRIC_DEFS).sort());
    expect(JSON.parse(lines[6]!)).toMatchObject({ state: 'pending', market: 'US', 'transfer.stuck': 600 });
  });
});

describe('units', () => {
  it('every metric unit is a CloudWatch StandardUnit', () => {
    const standard = ['Seconds', 'Microseconds', 'Milliseconds', 'Bytes', 'Kilobytes', 'Megabytes', 'Gigabytes', 'Terabytes', 'Bits', 'Kilobits', 'Megabits', 'Gigabits', 'Terabits', 'Percent', 'Count', 'Bytes/Second', 'Kilobytes/Second', 'Megabytes/Second', 'Gigabytes/Second', 'Terabytes/Second', 'Bits/Second', 'Kilobits/Second', 'Megabits/Second', 'Gigabits/Second', 'Terabits/Second', 'Count/Second', 'None'];
    for (const [name, def] of Object.entries(METRIC_DEFS)) expect(standard, name).toContain(def.unit);
  });
});

describe('the dimension set is closed', () => {
  it('is exactly market, port, job, state, provider and reason, and every metric draws from it', () => {
    expect([...METRIC_DIMENSIONS]).toEqual(['market', 'port', 'job', 'state', 'provider', 'reason']);
    for (const def of Object.values(METRIC_DEFS)) for (const d of [...def.dimensions, ...(('optional' in def ? def.optional : []) as readonly string[])]) expect(METRIC_DIMENSIONS).toContain(d);
  });

  it('fails on an unknown dimension, whatever it is called', () => {
    for (const name of ['memberId', 'accountId', 'transferId', 'partyId', 'user', 'route']) expect(() => validateDimensions({ [name]: 'x' }), name).toThrow(/Unknown metric dimension/);
    expect(() => validateDimensions({ job: 'load-sweep', port: 'card-issuing', market: 'IL', state: 'settled' })).not.toThrow();
  });

  it('writes no line for an unknown dimension, or for a dimension the metric does not carry', () => {
    const { metrics, lines } = capture();
    metrics.put({ 'job.failure': 1 }, { job: 'x', memberId: 'abc' } as never);
    metrics.put({ 'job.failure': 1 }, { port: 'card-issuing' });
    metrics.put({ 'job.failure': 1 });
    metrics.put({ 'jit.error': 1 }, { job: 'x' });
    expect(lines).toEqual([]);
  });

  it('never lets an id become a dimension value', () => {
    const { metrics, lines } = capture();
    metrics.jobFailure('0191a7c2-6b1e-7c3a-9d0e-2f4b5a6c7d8e'); // a UUID
    metrics.providerError('a0191a7c-6b1e-7c3a'); // hex run
    metrics.jobFailure('job-123456789');
    metrics.jobFailure('has space');
    metrics.transferStuck('not-a-state', 'IL', 1);
    metrics.webhookLag(1, 'Tel Aviv');
    expect(lines).toEqual([]);
    expect(() => validateDimensions({ job: 'x'.repeat(41) })).toThrow();
  });

  it('drops a non-finite value instead of printing it', () => {
    const { metrics, lines } = capture();
    metrics.webhookLag(Number.NaN, 'IL');
    metrics.reconBreakOldestHours(Infinity);
    expect(lines).toEqual([]);
  });
});

describe('a broken emitter changes nothing', () => {
  it('a throwing sink is swallowed', () => {
    const m = createMetrics({ write: () => { throw new Error('stdout closed'); } });
    expect(() => m.jitDecision(5, false)).not.toThrow();
  });

  it('guarded() swallows an injected emitter that throws on every method', () => {
    const boom = new Proxy({}, { get: () => () => { throw new Error('boom'); } }) as unknown as Metrics;
    const m = guarded(createMetrics({ write: () => undefined }));
    expect(() => m.put({ 'jit.error': 1 })).not.toThrow();
    const g = guarded({ ...(Object.fromEntries(['put', 'jitDecision', 'webhookLag', 'jobFailure', 'jobAge', 'reconBreakOpenUsd', 'reconBreakOldestHours', 'transferStuck', 'providerError', 'webhookRejected'].map((k) => [k, () => { throw new Error(k); }])) as unknown as Metrics) });
    expect(() => { g.jitDecision(1, false); g.jobFailure('x'); g.providerError('p'); }).not.toThrow();
    expect(boom).toBeDefined();
  });
});

describe('minorToNumber', () => {
  it('makes a plain number from bigint minor units, exactly at two decimals', () => {
    expect(minorToNumber(0n)).toBe(0);
    expect(minorToNumber(12_345n)).toBe(123.45);
    expect(minorToNumber(5_000n)).toBe(50);
    expect(minorToNumber(-250n)).toBe(-2.5);
    expect(minorToNumber(9_007_199_254_740_993_00n)).toBeGreaterThan(9e15);
  });
});

describe('provider.error and webhook.rejected (T-0689)', () => {
  it('provider.error carries {port} for the alarms and {port, provider} as a second set on the same line', () => {
    const { metrics, lines } = capture();
    metrics.providerError('fx', 'simulator');
    metrics.providerError('fx');
    const [split, bare] = lines.map((l) => JSON.parse(l) as { _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] } } & Record<string, unknown>);
    expect(split!._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([['port'], ['port', 'provider']]);
    expect(split).toMatchObject({ port: 'fx', provider: 'simulator', 'provider.error': 1 });
    expect(bare!._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([['port']]);
  });

  it('webhook.rejected carries provider and a reason from a closed set; free text and ids are refused', () => {
    const { metrics, lines } = capture();
    metrics.webhookRejected('stripe', 'bad_signature');
    expect(JSON.parse(lines[0]!)).toMatchObject({ provider: 'stripe', reason: 'bad_signature', 'webhook.rejected': 1 });
    metrics.webhookRejected('0191a7c2-6b1e-7c3a-9d0e-2f4b5a6c7d8e', 'bad_signature');
    expect(lines).toHaveLength(1);
    expect(webhookRejectReason('bad signature')).toBe('bad_signature');
    expect(webhookRejectReason('missing signature')).toBe('missing_signature');
    expect(webhookRejectReason('NO_SIGNATURE')).toBe('missing_signature');
    expect(webhookRejectReason('MISMATCH')).toBe('bad_signature');
    expect(webhookRejectReason('timestamp outside tolerance')).toBe('stale');
    expect(webhookRejectReason(undefined)).toBe('other');
  });
});

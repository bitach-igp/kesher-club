// T-0610 I07 Allowances (screen rows of TST-INS-003 and TST-INS-004): the preview total equals the sum of
// its rows (bigint); the requester sees no Approve on their own run; a run takes one step-up and keeps its
// key; a rerun shows the earlier result and pays nobody twice; FEATURE_OFF is the off state.
import { describe, expect, it } from 'vitest';
import { canApprove, earlierRun, executeRun, previewRun, rowsTotal, type Result, type RunDeps, type RunResult, type RunSummary } from './allowances.ts';
import { COPY, localeFrom, t } from './i18n.ts';

const SCHEDULE = '0190a0a0-0000-7000-8000-0000000000c1';
const ils = (minor: string) => ({ minor, currency: 'ILS' as const });
const preview = (rows: string[], total: string): RunResult => ({ workflowId: `allowance:${SCHEDULE}:2026-11-20`, status: 'preview', memberCount: rows.length, total: ils(total), rows: rows.map((m, i) => ({ memberName: `Student ${i}`, amount: ils(m) })) });
const summary = (over: Partial<RunSummary> = {}): RunSummary => ({ workflowId: `allowance:${SCHEDULE}:2026-11-20`, scheduleId: SCHEDULE, scheduleName: 'Weekly', runDate: '2026-11-20', status: 'awaiting_second_approval', memberCount: 2, total: ils('600000'), paidTotal: ils('0'), paid: 0, failed: 0, approvedBy: [{ displayName: 'Finance •••• 0109' }], requestedBy: { displayName: 'Finance •••• 0109' }, requestedByMe: false, ...over });

/** A fake API: the run answers in turn; the paid set shows who the "ledger" paid, keyed like the API. */
function fakeDeps(opts: { preview?: Result<RunResult>; runs?: Result<RunResult>[]; stepUp?: boolean } = {}) {
  const calls = { run: [] as string[], stepUp: 0 };
  const paid = new Set<string>();
  const runs = [...(opts.runs ?? [])];
  let n = 0;
  const deps: RunDeps = {
    preview: async () => opts.preview ?? { ok: false, code: 'NOT_FOUND' },
    async run(scheduleId, date, key) {
      calls.run.push(key);
      const r = runs.shift() ?? { ok: false, code: 'NOT_FOUND' };
      // The API pays each member once per run (workflow id + member); a rerun adds nobody.
      if (r.ok && r.value.status === 'completed') for (let i = 0; i < r.value.memberCount; i++) paid.add(`allowance:${scheduleId}:${date}:${i}`);
      return r;
    },
    async stepUp() {
      calls.stepUp += 1;
      return opts.stepUp ?? true;
    },
    newKey: () => `key-${++n}`,
  };
  return { deps, calls, paid };
}

describe('I07 allowances (T-0610)', () => {
  it('a preview\'s total equals the sum of its rows, in bigint; a total that is not their sum is not shown', async () => {
    const ok = await previewRun(fakeDeps({ preview: { ok: true, value: preview(['300000', '300000', '1'], '600001') } }).deps, SCHEDULE, '2026-11-20');
    expect(ok).toMatchObject({ kind: 'preview', total: { minor: 600_001n, currency: 'ILS' } });
    expect(rowsTotal(preview(['9007199254740993', '1'], '0').rows!)).toBe(9_007_199_254_740_994n);
    expect(await previewRun(fakeDeps({ preview: { ok: true, value: preview(['300000'], '600000') } }).deps, SCHEDULE, '2026-11-20')).toEqual({ kind: 'error', code: 'PREVIEW_MISMATCH' });
  });

  it('the requester sees no Approve on their own run; a second finance member does; staff never do', () => {
    expect(canApprove(summary({ requestedByMe: true }), 'finance')).toBe(false);
    expect(canApprove(summary(), 'finance')).toBe(true);
    expect(canApprove(summary(), 'staff')).toBe(false);
    expect(canApprove(summary({ status: 'completed' }), 'finance')).toBe(false);
  });

  it('a run takes one step-up and retries once with the same key; a cancelled step-up pays nothing', async () => {
    const done: RunResult = { ...preview(['20000', '20000'], '40000'), status: 'completed', failures: 0 };
    const { deps, calls } = fakeDeps({ runs: [{ ok: false, code: 'STEP_UP_REQUIRED' }, { ok: true, value: done }] });
    expect(await executeRun(deps, SCHEDULE, '2026-11-20')).toEqual({ kind: 'completed', run: done });
    expect([calls.run, calls.stepUp]).toEqual([['key-1', 'key-1'], 1]);

    const cancelled = fakeDeps({ runs: [{ ok: false, code: 'STEP_UP_REQUIRED' }], stepUp: false });
    expect(await executeRun(cancelled.deps, SCHEDULE, '2026-11-20')).toEqual({ kind: 'cancelled' });
    expect(cancelled.calls.run).toEqual(['key-1']);
  });

  it('over ₪5,000 the requester waits; the second member\'s Approve posts the same run and completes it', async () => {
    const waiting: RunResult = { ...preview(['300000', '300000'], '600000'), status: 'awaiting_second_approval' };
    const completed: RunResult = { ...waiting, status: 'completed', failures: 0 };
    const { deps } = fakeDeps({ runs: [{ ok: true, value: waiting }, { ok: true, value: completed }] });
    expect((await executeRun(deps, SCHEDULE, '2026-11-20')).kind).toBe('waiting');
    expect((await executeRun(deps, SCHEDULE, '2026-11-20')).kind).toBe('completed');
  });

  it('a rerun shows the earlier result and pays nobody twice', async () => {
    const done: RunResult = { ...preview(['20000', '20000'], '40000'), status: 'completed', failures: 0 };
    const { deps, paid } = fakeDeps({ runs: [{ ok: true, value: done }, { ok: true, value: done }] });
    await executeRun(deps, SCHEDULE, '2026-11-20');
    const again = await executeRun(deps, SCHEDULE, '2026-11-20');
    expect(again).toEqual({ kind: 'completed', run: done });
    expect(paid.size).toBe(2);
    // The screen offers no Run once the history holds the run; a preview does not count as one.
    const history = [summary({ status: 'preview', runDate: '2026-11-27' }), summary({ status: 'completed' })];
    expect(earlierRun(history, SCHEDULE, '2026-11-20')).toMatchObject({ status: 'completed' });
    expect(earlierRun(history, SCHEDULE, '2026-11-27')).toBeUndefined();
  });

  it('FEATURE_OFF (institutions.money) is the off state, for the preview and the run', async () => {
    const { deps } = fakeDeps({ preview: { ok: false, code: 'FEATURE_OFF' }, runs: [{ ok: false, code: 'FEATURE_OFF' }] });
    expect(await previewRun(deps, SCHEDULE, '2026-11-20')).toEqual({ kind: 'off' });
    expect(await executeRun(deps, SCHEDULE, '2026-11-20')).toEqual({ kind: 'off' });
  });

  it('copy: Hebrew mirrors every English key; names arrive as vars; the browser\'s first language decides', () => {
    expect(Object.keys(COPY.he).sort()).toEqual(Object.keys(COPY.en).sort());
    expect(t('allowances.requestedBy', 'en', { name: '<b>Rivka</b>' })).toBe('Asked by <b>Rivka</b>');
    expect([localeFrom('he-IL,he;q=0.9,en;q=0.8'), localeFrom('en-US,he;q=0.5'), localeFrom(undefined)]).toEqual(['he', 'en', 'en']);
  });
});

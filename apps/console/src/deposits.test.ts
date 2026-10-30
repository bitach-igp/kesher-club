// T-0630 Deposits (screen rows of TST-INS-009): an amount parses to cents and anything else is refused before the
// API is called; a held pull shows its date and a returned one says so; a retry after a lost answer keeps its key
// and a new amount gets a new one; 404 and FEATURE_OFF read as sentences; an IL institution has no Deposits.
import { describe, expect, it } from 'vitest';
import type { Result } from './api.ts';
import { attemptFor, errorKey, parseDollars, showsDeposits, stateLine, submitPull, type AchPull, type AchPullRequest, type PullDeps } from './deposits.ts';
import type { Landing } from './session.ts';

const pull = (over: Partial<AchPull> = {}): AchPull => ({ id: 'a1', state: 'on_hold', amount: { minor: '1000000', currency: 'USD' }, holdUntil: '2026-11-05', createdAt: '2026-11-02T09:00:00Z', ...over });

function fake(answers: Result<AchPull>[], stepUp = true) {
  const calls = { create: [] as { body: AchPullRequest; key: string }[], stepUp: 0 };
  let n = 0;
  const deps: PullDeps = {
    async create(body, key) {
      calls.create.push({ body, key });
      return answers.shift() ?? { ok: false, code: 'NOT_FOUND' };
    },
    async stepUp() {
      calls.stepUp += 1;
      return stepUp;
    },
    newKey: () => `key-${++n}`,
  };
  return { deps, calls };
}

describe('T-0630 Deposits', () => {
  it('parses dollars to cents and refuses anything else before calling the API', async () => {
    expect(parseDollars('10,000.50')).toBe(1_000_050n);
    expect(parseDollars('$250')).toBe(25_000n);
    for (const bad of ['', '0', '1.234', 'ten', '-5']) expect(parseDollars(bad), bad).toBeUndefined();
    const f = fake([]);
    expect(await submitPull(f.deps, '1.234', undefined)).toEqual({ outcome: { kind: 'invalid' }, attempt: undefined });
    expect(f.calls.create).toEqual([]);
  });

  it('a held pull shows its date, a settled one is the institution\'s, a returned one says so', () => {
    expect(stateLine(pull())).toEqual({ key: 'deposits.state.on_hold', vars: { date: '2026-11-05' } });
    expect(stateLine(pull({ state: 'settled' }))).toEqual({ key: 'deposits.state.settled' });
    expect(stateLine(pull({ state: 'failed', failureCode: 'VENDOR_FAILED' }))).toEqual({ key: 'deposits.state.failed', vars: { code: 'VENDOR_FAILED' } });
    expect(stateLine(pull({ state: 'processing' }))).toEqual({ key: 'deposits.state.processing' });
  });

  it('a retry of the same amount keeps its key, after a lost answer or a step-up; a new amount is a new pull', async () => {
    const f = fake([{ ok: false, code: 'PROVIDER_UNAVAILABLE' }, { ok: false, code: 'STEP_UP_REQUIRED' }, { ok: true, value: pull() }, { ok: true, value: pull({ id: 'a2' }) }]);
    const first = await submitPull(f.deps, '10,000', undefined);
    expect(first.outcome).toEqual({ kind: 'error', code: 'PROVIDER_UNAVAILABLE' });
    const second = await submitPull(f.deps, ' 10,000 ', first.attempt);
    expect(second).toEqual({ outcome: { kind: 'done', pull: pull() }, attempt: undefined });
    expect(f.calls.create.map((c) => c.key)).toEqual(['key-1', 'key-1', 'key-1']);
    expect(f.calls.create[0]!.body).toEqual({ amount: { minor: '1000000', currency: 'USD' } });
    expect(f.calls.stepUp).toBe(1);
    await submitPull(f.deps, '500', undefined);
    expect(f.calls.create.at(-1)!.key).toBe('key-2');
    expect(attemptFor({ amountText: '10', key: 'k' }, '11', () => 'fresh')).toEqual({ amountText: '11', key: 'fresh' });
  });

  it('a cancelled passkey moves nothing; refusals read as sentences', async () => {
    const f = fake([{ ok: false, code: 'STEP_UP_REQUIRED' }], false);
    expect((await submitPull(f.deps, '100', undefined)).outcome).toEqual({ kind: 'cancelled' });
    expect(f.calls.create).toHaveLength(1);
    expect(errorKey('NOT_FOUND')).toBe('error.forbidden');
    expect(errorKey('FEATURE_OFF')).toBe('deposits.off');
    expect(errorKey('VALIDATION_FAILED')).toBe('error.generic');
  });

  it('only a US institution\'s finance staff see Deposits', () => {
    const at = (market: 'US' | 'IL', role: 'staff' | 'finance' | 'admin'): Landing => ({ kind: 'dashboard', institution: { id: 'i', name: 'Y', market }, role, paymentReference: 'KC-1' });
    expect(showsDeposits(at('US', 'finance'))).toBe(true);
    expect(showsDeposits(at('IL', 'finance'))).toBe(false);
    expect(showsDeposits(at('US', 'staff'))).toBe(false);
    expect(showsDeposits({ kind: 'signed_out' })).toBe(false);
  });
});

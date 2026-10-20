// T-0525 P07 auto-reload (screen rows of TST-WAL-004): the rule is read and set per purse; a target at or
// below the threshold never reaches the API; amounts go out as minor-unit strings; turning the rule off
// keeps its amounts; FEATURE_OFF leaves nothing to set.
import { describe, expect, it } from 'vitest';
import type { Account, AutoReloadApi, AutoReloadRule, AutoReloadRuleRequest } from '../../src/api.ts';
import { createAutoReloadModel } from './auto-reload.model.ts';

const USD_ACCOUNT = '0190a0a0-0000-7000-8000-0000000000aa';
const ILS_ACCOUNT = '0190a0a0-0000-7000-8000-0000000000bb';
const accounts: Account[] = [
  { id: USD_ACCOUNT, currency: 'USD', settled: { minor: '4500', currency: 'USD' }, holds: { minor: '0', currency: 'USD' }, available: { minor: '4500', currency: 'USD' } },
  { id: ILS_ACCOUNT, currency: 'ILS', settled: { minor: '0', currency: 'ILS' }, holds: { minor: '0', currency: 'ILS' }, available: { minor: '0', currency: 'ILS' } },
];

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const ruleFrom = (accountId: string, r: AutoReloadRuleRequest, extra: Partial<AutoReloadRule> = {}): AutoReloadRule => ({ accountId, currency: r.target.currency, enabled: r.enabled, method: r.method, paymentMethodId: r.paymentMethodId, threshold: r.threshold, target: r.target, ...extra });

function setup(opts: { rules?: Record<string, AutoReloadRule>; getError?: Error; setErrors?: Error[]; saved?: { id: string; label: string }[] } = {}) {
  const rules = { ...(opts.rules ?? {}) };
  const sets: { accountId: string; rule: AutoReloadRuleRequest; key: string }[] = [];
  const setErrors = [...(opts.setErrors ?? [])];
  let n = 0;
  const reload: AutoReloadApi = {
    async get(id) {
      if (opts.getError) throw opts.getError;
      const r = rules[id];
      if (!r) throw new Problem('NOT_FOUND', 404);
      return r;
    },
    async set(id, rule, key) {
      sets.push({ accountId: id, rule, key });
      const e = setErrors.shift();
      if (e) throw e;
      rules[id] = ruleFrom(id, rule);
      return rules[id];
    },
    paymentMethods: async () => opts.saved ?? [{ id: 'pm_saved', label: 'Visa •• 4242' }],
  };
  const model = createAutoReloadModel({ reload, accounts: async () => ({ items: accounts }), newKey: () => `key-${++n}` });
  return { model, sets };
}

describe('P07 auto-reload (T-0525)', () => {
  it('with no rule yet, shows an empty form off, with the saved method preselected', async () => {
    const { model } = setup();
    await model.load();
    expect(model.store.get()).toMatchObject({ mode: 'ready', rule: undefined, enabled: false, thresholdText: '', targetText: '', paymentMethodId: 'pm_saved', method: 'card' });
  });

  it('a target at or below the threshold is refused before any call', async () => {
    const { model, sets } = setup();
    await model.load();
    model.setThreshold('50');
    model.setTarget('50');
    await model.save();
    model.setTarget('49.99');
    await model.save();
    expect(sets).toEqual([]);
    expect(model.store.get().error).toEqual({ key: 'reload.target.aboveThreshold' });
  });

  it('saving sends minor units as strings in the purse currency, on the purse\'s account', async () => {
    const { model, sets } = setup();
    await model.load();
    await model.setPurse('ILS');
    model.setThreshold('45');
    model.setTarget('200.50');
    model.setMethod('apple_pay');
    await model.save();
    expect(sets).toEqual([{ accountId: ILS_ACCOUNT, key: 'key-1', rule: { enabled: true, method: 'apple_pay', paymentMethodId: 'pm_saved', threshold: { minor: '4500', currency: 'ILS' }, target: { minor: '20050', currency: 'ILS' } } }]);
    expect(model.store.get()).toMatchObject({ rule: { enabled: true }, notice: { key: 'reload.saved.on' } });
  });

  it('turning the rule off keeps its amounts for next time', async () => {
    const on = ruleFrom(USD_ACCOUNT, { enabled: true, method: 'card', paymentMethodId: 'pm_saved', threshold: { minor: '5000', currency: 'USD' }, target: { minor: '20000', currency: 'USD' } }, { lastAttemptAt: '2026-10-19T08:00:00Z' });
    const { model, sets } = setup({ rules: { [USD_ACCOUNT]: on } });
    await model.load();
    expect(model.store.get()).toMatchObject({ enabled: true, thresholdText: '50.00', targetText: '200.00', rule: { lastAttemptAt: '2026-10-19T08:00:00Z' } });
    await model.turnOff();
    expect(sets[0]!.rule).toEqual({ enabled: false, method: 'card', paymentMethodId: 'pm_saved', threshold: { minor: '5000', currency: 'USD' }, target: { minor: '20000', currency: 'USD' } });
    expect(model.store.get()).toMatchObject({ enabled: false, thresholdText: '50.00', targetText: '200.00', notice: { key: 'reload.saved.off' } });
  });

  it('FEATURE_OFF hides the tab: nothing to set', async () => {
    const { model } = setup({ getError: new Problem('FEATURE_OFF', 404) });
    await model.load();
    expect(model.store.get().mode).toBe('off');
  });

  it('a step-up refusal keeps the attempt; an edit starts a new one; no saved method says so before any call', async () => {
    const { model, sets } = setup({ setErrors: [new Problem('STEP_UP_REQUIRED', 401)] });
    await model.load();
    model.setThreshold('10');
    model.setTarget('100');
    await model.save();
    expect(model.store.get()).toMatchObject({ needsStepUp: true, attemptKey: 'key-1' });
    await model.save();
    expect(sets.map((s) => s.key)).toEqual(['key-1', 'key-1']);

    const none = setup({ saved: [] });
    await none.model.load();
    none.model.setThreshold('10');
    none.model.setTarget('100');
    await none.model.save();
    expect(none.sets).toEqual([]);
    expect(none.model.store.get().error).toEqual({ key: 'reload.method.none' });
  });
});

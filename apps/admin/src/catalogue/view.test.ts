// T-0929 A05 (screen rows of TST-MKT-002): the propose form is checked before the call; the margin leaves as basis
// points and the floor as minor units; the worked price equals the API's formula on its own example; the proposer
// is never offered Approve or Reject, and support decides nothing.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { canDecide, parseRuleForm, percentToBps, workedPrice } from './view.ts';
import type { PriceRuleRow } from '../data/types.ts';

const form = { kind: 'esim', provider: 'simulator', skuPattern: '^IL-', margin: '25', floor: '0', currency: 'USD', roundTo99: 'on', priority: '10', reason: 'Launch margin for Israel eSIMs' };
const rule = (over: Partial<PriceRuleRow> = {}): PriceRuleRow => ({ id: 'r1', kind: 'esim', provider: 'simulator', skuPattern: '^IL-', marginBps: 2500, floor: money(0n, 'USD'), roundTo99: true, priority: 10, state: 'proposed', proposedBy: 'staff-finance-1', createdAt: '2026-11-10T09:00:00Z', ...over });

describe('A05 price rules (T-0929)', () => {
  it('turns the form into basis points and minor units, and refuses what the API would', () => {
    expect(parseRuleForm(form)).toEqual({ ok: true, input: { kind: 'esim', provider: 'simulator', skuPattern: '^IL-', marginBps: 2500, floor: money(0n, 'USD'), roundTo99: true, priority: 10, reason: 'Launch margin for Israel eSIMs' } });
    expect([percentToBps('12.5'), percentToBps('200'), percentToBps('200.01'), percentToBps('-1'), percentToBps('1.234')]).toEqual([1250, 20_000, undefined, undefined, undefined]);
    expect(parseRuleForm({ ...form, skuPattern: '', roundTo99: undefined })).toMatchObject({ ok: true, input: { skuPattern: '.*', roundTo99: false } });
    expect(parseRuleForm({ ...form, kind: 'flights', provider: 'Sim Co', skuPattern: '(', margin: '250', floor: '20000', priority: '0', reason: ' ' })).toEqual({ ok: false, problems: ['kind', 'provider', 'pattern', 'margin', 'floor', 'priority', 'reason'] });
  });

  it('shows the worked price the API would charge: $9.50 at 25% is $11.88, $11.99 rounded', () => {
    expect(workedPrice(rule(), money(950n, 'USD'))).toEqual(money(1199n, 'USD'));
    expect(workedPrice(rule({ roundTo99: false }), money(950n, 'USD'))).toEqual(money(1188n, 'USD'));
    expect(workedPrice(rule({ floor: money(1500n, 'USD'), roundTo99: false }), money(950n, 'USD'))).toEqual(money(1500n, 'USD'));
  });

  it('offers Approve and Reject to a different finance member only, on a proposed rule', () => {
    const finance2 = { subject: 'staff-finance-2', roles: ['finance'] };
    expect(canDecide(rule(), finance2)).toBe(true);
    expect(canDecide(rule(), { subject: 'staff-finance-1', roles: ['finance'] })).toBe(false);
    expect(canDecide(rule(), { subject: 'staff-support-1', roles: ['support'] })).toBe(false);
    expect(canDecide(rule({ state: 'active' }), finance2)).toBe(false);
  });
});

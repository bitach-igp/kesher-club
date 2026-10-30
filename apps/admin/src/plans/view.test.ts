// T-0933 A13 Plans (TST-ADM-006 at the screen): the form leaves the price in minor units of the market's own currency
// and refuses what the API would; the worked monthly price rounds up and reads in both the English and the Hebrew
// format; only a different finance member is offered Approve or Reject; versions group by plan, newest first; and in
// the memory store, B's approval makes the new version the one offered while the proposer's is refused.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { memoryAdminData } from '../data/memory.ts';
import type { PlanVersionRow } from '../data/types.ts';
import { byPlan, canDecide, monthlyPrice, parsePlanForm, parseVersionKey, priceMinor, versionKey, workedMonthly } from './view.ts';

const FIN_A = { subject: 'fin-a', roles: ['finance'] };
const FIN_B = { subject: 'fin-b', roles: ['finance'] };
const SUPPORT = { subject: 'sup', roles: ['support'] };
const form = { planCode: 'club-il', name: 'Kesher Club Israel', market: 'IL', price: '1,800.50', termMonths: '10', dataGb: '5', conciergeCalls: '', fxMarkup: '', effectiveFrom: '', reason: 'Launch price' };
const row = (over: Partial<PlanVersionRow> = {}): PlanVersionRow => ({ planCode: 'club-il', name: 'Kesher Club Israel', version: 1, market: 'IL', price: money(18_000n, 'ILS'), termMonths: 10, entitlements: {}, fxMarkupBps: 75, effectiveFrom: '2026-11-01T00:00:00Z', state: 'proposed', offered: false, proposedBy: 'fin-a', createdAt: '2026-11-01T00:00:00Z', ...over });

describe('T-0933 plans model', () => {
  it("leaves the price in minor units of the market's currency, with the entitlements given and the default markup", () => {
    expect(parsePlanForm(form)).toEqual({ ok: true, input: { planCode: 'club-il', name: 'Kesher Club Israel', market: 'IL', price: money(180_050n, 'ILS'), termMonths: 10, entitlements: { 'esim.dataGb': { limit: '5', unit: 'gb', period: 'month' } }, fxMarkupBps: 75, reason: 'Launch price' } });
    expect(parsePlanForm({ ...form, market: 'US', conciergeCalls: '3', effectiveFrom: '2027-01-01', fxMarkup: '1.5' })).toMatchObject({ ok: true, input: { price: money(180_050n, 'USD'), entitlements: { 'concierge.calls': { limit: '3', unit: 'calls', period: 'term' } }, fxMarkupBps: 150, effectiveFrom: '2027-01-01T00:00:00Z' } });
  });

  it('refuses a bad price, term, market, code, entitlement, markup, date or reason before any call', () => {
    expect(parsePlanForm({ ...form, price: '0', termMonths: '13', market: 'EU', planCode: 'Club IL', dataGb: 'five', fxMarkup: '150', effectiveFrom: '2027-02-30', reason: ' ' })).toEqual({ ok: false, problems: ['code', 'market', 'price', 'term', 'data', 'fx', 'date', 'reason'] });
    for (const bad of ['-5', '1.234', '100000.01', 'ten']) expect(priceMinor(bad), bad).toBeUndefined();
    expect(priceMinor('100000')).toBe(10_000_000n);
    expect(parsePlanForm({ ...form, termMonths: '2.5' })).toEqual({ ok: false, problems: ['term'] });
  });

  it('works the monthly price out rounded up, in the English and the Hebrew format', () => {
    expect(monthlyPrice(money(18_000n, 'ILS'), 10)).toEqual(money(1_800n, 'ILS'));
    expect(monthlyPrice(money(10_000n, 'USD'), 12)).toEqual(money(834n, 'USD'));
    expect(workedMonthly(money(18_000n, 'ILS'), 10)).toEqual({ en: '₪18.00 a month', he: '18.00 ₪ לחודש' });
    expect(workedMonthly(money(4_900n, 'USD'), 10)).toEqual({ en: '$4.90 a month', he: '4.90 $ לחודש' });
  });

  it('offers Approve and Reject only to a different finance member, on a proposed version', () => {
    expect(canDecide(row(), FIN_B)).toBe(true);
    expect(canDecide(row(), FIN_A)).toBe(false);
    expect(canDecide(row(), SUPPORT)).toBe(false);
    expect(canDecide(row({ state: 'active' }), FIN_B)).toBe(false);
  });

  it('groups by plan, each newest first, and round-trips a version in a URL segment', () => {
    const groups = byPlan([row({ version: 1 }), row({ planCode: 'club-us', name: 'Club US', market: 'US', price: money(4_900n, 'USD') }), row({ version: 2 })]);
    expect(groups.map((g) => [g.planCode, g.versions.map((v) => v.version)])).toEqual([
      ['club-il', [2, 1]],
      ['club-us', [1]],
    ]);
    expect(parseVersionKey(versionKey(row({ version: 12 })))).toEqual({ planCode: 'club-il', version: 12 });
    for (const bad of ['club-il', 'club-il:0', 'Club:1', 'club-il:1:2']) expect(parseVersionKey(bad), bad).toBeUndefined();
  });

  it('in the memory store, the proposer is refused, B approves and the new version is the one offered', async () => {
    const data = memoryAdminData();
    const now = new Date('2026-11-10T09:00:00Z');
    const input = (parsePlanForm({ ...form, planCode: 'demo-club-il' }) as Extract<ReturnType<typeof parsePlanForm>, { ok: true }>).input;
    await expect(data.proposePlanVersion(input, SUPPORT, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const v2 = await data.proposePlanVersion(input, FIN_A, now);
    expect(v2).toMatchObject({ version: 2, state: 'proposed', offered: false, name: 'Demo Club Israel (demo price)' });
    await expect(data.decidePlanVersion('demo-club-il', 2, 'approve', FIN_A, undefined, now)).rejects.toMatchObject({ code: 'SAME_APPROVER' });
    expect(await data.decidePlanVersion('demo-club-il', 2, 'approve', FIN_B, undefined, now)).toMatchObject({ state: 'active', offered: true });
    expect((await data.listPlanVersions()).filter((v) => v.planCode === 'demo-club-il').map((v) => [v.version, v.offered])).toEqual([
      [2, true],
      [1, false],
    ]);
    await expect(data.decidePlanVersion('demo-club-il', 2, 'reject', FIN_B, 'late', now)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

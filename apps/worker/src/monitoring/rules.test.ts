// Monitoring rules v1 (T-0909, REQ-CMP-001). TST-CMP-001 at the rule level: ten sends of ₪490 within
// an hour are one structuring finding and nine, or ten over a longer hour, are none; the velocity
// and fan-in / fan-out thresholds; the same data gives the same keys in any order, so a re-run can
// open no duplicate; a summary is built from numbers and ids only.
import { describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { evaluate, fanIn, fanOut, lookbackMs, structuring, THRESHOLDS, velocity, type Movement } from './rules.ts';

const T0 = new Date('2026-11-10T09:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const noa = uuidv7(T0);
const dan = uuidv7(T0);
const lior = uuidv7(T0);
const party = (): string => uuidv7(T0);

let seq = 0;
const send = (from: string, to: string, minor: bigint, when: Date, kind: Movement['kind'] = 'p2p'): Movement => ({ id: `${when.toISOString()}-${(seq++).toString().padStart(4, '0')}`, kind, fromPartyId: from, toPartyId: to, amount: money(minor, 'ILS'), at: when });
/** n sends of `minor` from `from` to `to`, evenly spread from `start` over `spanMinutes`. */
const burst = (from: string, to: string, minor: bigint, n: number, start: number, spanMinutes: number): Movement[] => Array.from({ length: n }, (_, i) => send(from, to, minor, at(start + (i * spanMinutes) / Math.max(1, n - 1))));

describe('TST-CMP-001: structuring', () => {
  it('ten sends of ₪490 within an hour are one finding, anchored on the first send; nine are none; ten across more than an hour are none', () => {
    const ten = burst(noa, dan, 49_000n, 10, 0, 54);
    const f = structuring(ten);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'structuring', caseKind: 'structuring', severity: 'high', partyId: noa, currency: 'ILS', count: 10, counterparties: 1, total: money(490_000n, 'ILS'), transferIds: ten.map((m) => m.id), window: { start: at(0), end: at(60) } });
    expect(f[0]!.dedupeKey).toBe(`structuring:${noa}:ILS:${ten[0]!.id}`);
    expect(f[0]!.summary).toBe('10 sends of ₪490.00 (₪4,900.00 in all) within 1 hour, each just under the ₪500.00 hold line');
    expect(structuring(ten.slice(1))).toEqual([]);
    expect(structuring(burst(noa, dan, 49_000n, 10, 0, 61))).toEqual([]);
  });

  it('counts only sends kept just under the hold line: at the line, well under it, or not a send, they do not count', () => {
    expect(structuring(burst(noa, dan, 50_000n, 12, 0, 30))).toEqual([]); // at the line: the hold itself catches these
    expect(structuring(burst(noa, dan, 30_000n, 12, 0, 30))).toEqual([]); // 60 %: ordinary small sends
    expect(structuring(burst(noa, dan, 40_000n, 10, 0, 30))).toHaveLength(1); // 80 %: the edge counts
    expect(structuring(burst(noa, dan, 49_000n, 12, 0, 30).map((m) => ({ ...m, kind: 'payout' as const })))).toEqual([]);
    // Mixed amounts: the summary drops the "of ₪x" part.
    const mixed = [...burst(noa, dan, 49_000n, 5, 0, 20), ...burst(noa, dan, 45_000n, 5, 21, 20)];
    expect(structuring(mixed)[0]!.summary).toBe('10 sends (₪4,700.00 in all) within 1 hour, each just under the ₪500.00 hold line');
  });

  it('one long burst is one finding, and a second burst after the window is a second one with its own anchor', () => {
    const first = burst(noa, dan, 49_000n, 14, 0, 50);
    const second = burst(noa, dan, 49_000n, 10, 120, 50);
    const f = structuring([...second, ...first]);
    expect(f.map((x) => [x.count, x.transferIds[0]])).toEqual([
      [14, first[0]!.id],
      [10, second[0]!.id],
    ]);
    // Two currencies never mix: USD sends of $149 and ILS sends of ₪490 are two findings.
    const usd = Array.from({ length: 10 }, (_, i) => ({ ...send(noa, dan, 14_900n, at(i)), amount: money(14_900n, 'USD') }));
    expect(structuring([...usd, ...first]).map((x) => x.currency).sort()).toEqual(['ILS', 'USD']);
  });
});

describe('TST-CMP-001: velocity', () => {
  it('25 outgoing movements in a day, or ₪20,000 out, is a velocity finding; both at once is high', () => {
    const many = burst(lior, dan, 1_000n, 25, 0, 23 * 60);
    expect(velocity(many)).toHaveLength(1);
    expect(velocity(many)[0]).toMatchObject({ rule: 'velocity', caseKind: 'velocity', severity: 'medium', partyId: lior, count: 25, total: money(25_000n, 'ILS') });
    expect(velocity(many)[0]!.summary).toBe('25 outgoing movements, ₪250.00 in all, within 24 hours: over the movements limit (25 or ₪20,000.00)');
    expect(velocity(many.slice(1))).toEqual([]);
    const big = [send(lior, dan, 1_500_000n, at(0)), send(lior, dan, 500_000n, at(600), 'payout')];
    expect(velocity(big)[0]).toMatchObject({ severity: 'medium', count: 2, total: money(2_000_000n, 'ILS') });
    expect(velocity(big)[0]!.summary).toContain('over the amount limit');
    const both = [...many, send(lior, dan, 2_000_000n, at(10))];
    expect(velocity(both)[0]).toMatchObject({ severity: 'high', count: 26 });
    expect(velocity(both)[0]!.summary).toContain('over the movements and amount limit');
  });

  it('counts money leaving by the member\'s hand only: loads in, allowances and the recipient side do not count', () => {
    const loads = burst(lior, lior, 1_000n, 30, 0, 60).map((m) => ({ ...m, kind: 'load' as const }));
    const allowances = burst(lior, dan, 1_000n, 30, 0, 60).map((m) => ({ ...m, kind: 'allowance' as const }));
    expect(velocity([...loads, ...allowances])).toEqual([]);
    const received = burst(noa, dan, 1_000n, 30, 0, 60);
    expect(velocity(received).map((f) => f.partyId)).toEqual([noa]);
  });
});

describe('TST-CMP-001: fan-in and fan-out', () => {
  it('ten different senders to one member in a day is fan-in on the recipient; nine are none; the senders are clean', () => {
    const ten = Array.from({ length: 10 }, (_, i) => send(party(), dan, 2_000n, at(i * 60)));
    const f = fanIn(ten);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'fan_in', caseKind: 'velocity', severity: 'medium', partyId: dan, count: 10, counterparties: 10, total: money(20_000n, 'ILS') });
    expect(f[0]!.summary).toBe('received 10 sends from 10 different members, ₪200.00 in all, within 24 hours');
    expect(fanIn(ten.slice(1))).toEqual([]);
    // Twenty sends from the same two members are not fan-in.
    expect(fanIn([...burst(noa, dan, 2_000n, 10, 0, 60), ...burst(lior, dan, 2_000n, 10, 0, 60)])).toEqual([]);
    expect(fanOut(ten)).toEqual([]);
  });

  it('one member sending to ten different members in a day is fan-out; a transfer without a counterparty is skipped', () => {
    const ten = Array.from({ length: 10 }, (_, i) => send(lior, party(), 2_000n, at(i * 60)));
    expect(fanOut(ten)[0]).toMatchObject({ rule: 'fan_out', caseKind: 'velocity', partyId: lior, counterparties: 10 });
    expect(fanOut(ten)[0]!.summary).toBe('sent 10 times to 10 different members, ₪200.00 in all, within 24 hours');
    expect(fanOut(ten.slice(1))).toEqual([]);
    const payouts = ten.map((m) => ({ ...m, kind: 'payout' as const, toPartyId: undefined }));
    expect(fanOut(payouts)).toEqual([]);
    expect(fanIn(payouts)).toEqual([]);
  });
});

describe('TST-CMP-001: evaluate', () => {
  it('runs every rule, orders findings by key, and gives the same keys for the same data in any order', () => {
    const structured = burst(noa, dan, 49_000n, 10, 0, 54);
    const spray = Array.from({ length: 25 }, (_, i) => send(lior, party(), 1_000n, at(i * 50)));
    const all = [...structured, ...spray];
    const a = evaluate(all);
    const b = evaluate([...all].reverse());
    expect(a.map((f) => [f.rule, f.partyId])).toEqual([
      ['fan_out', lior],
      ['structuring', noa],
      ['velocity', lior],
    ]);
    expect(b.map((f) => f.dedupeKey)).toEqual(a.map((f) => f.dedupeKey));
    expect(new Set(a.map((f) => f.dedupeKey)).size).toBe(3);
    expect(lookbackMs()).toBe(24 * 60 * 60_000);
    expect(THRESHOLDS.structuring.line.ILS).toBe(50_000n);
  });

  it('a summary is numbers and ids: nothing a member typed can reach it', () => {
    const f = evaluate(burst(noa, dan, 49_000n, 10, 0, 54))[0]!;
    for (const value of [f.summary, f.dedupeKey, ...f.transferIds]) expect(value).toMatch(/^[\w\s.,:;()₪$%-]*$/u);
  });
});

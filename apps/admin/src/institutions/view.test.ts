// T-0615 the console's institutions area (screen rows of TST-INS-007, TST-ADM-004): an amount typed in major
// units leaves as minor units (bigint, past 2^53); Masav is shekels and ACH dollars; the recorder gets no
// Approve; support records nothing; a 409 reads as words.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { memoryAdminData } from '../data/memory.ts';
import type { Deposit } from '../data/types.ts';
import { canDecide, errorWords, isFinance, majorToMinor, parseDepositForm } from './view.ts';

const NOW = new Date('2026-11-10T09:00:00Z');
const FINN = { subject: 'staff-finance-1', roles: ['admin', 'finance'] };
const FERN = { subject: 'staff-finance-2', roles: ['admin', 'finance'] };
const SAM = { subject: 'staff-support-1', roles: ['admin', 'support'] };
const pending = (over: Partial<Deposit> = {}): Deposit => ({ id: 'd1', amount: money(2_000_000n, 'ILS'), rail: 'masav', bankReference: 'FT2611-ABC', valueDate: '2026-11-09', status: 'pending', approvals: 1, recordedByMe: false, createdAt: NOW.toISOString(), ...over });
const form = { amount: '20,000.00', currency: 'ILS', rail: 'masav', bankReference: ' ft 2611-abc ', valueDate: '2026-11-09', key: 'k-1' };

describe('console institutions (T-0615)', () => {
  it('an amount in major units leaves as minor units, in bigint, past 2^53', () => {
    expect(majorToMinor('20,000.50')).toBe(2_000_050n);
    expect(majorToMinor('90071992547409.93')).toBe(9_007_199_254_740_993n);
    expect([majorToMinor('0'), majorToMinor('1.234'), majorToMinor('abc')]).toEqual([undefined, undefined, undefined]);
    expect(parseDepositForm(form, NOW)).toEqual({ ok: true, input: { amount: money(2_000_000n, 'ILS'), rail: 'masav', bankReference: 'FT2611-ABC', valueDate: '2026-11-09', key: 'k-1' } });
  });

  it('Masav is shekels and ACH dollars; a future date, a missing reference and a missing rail are refused before any call', () => {
    expect(parseDepositForm({ ...form, currency: 'USD' }, NOW)).toEqual({ ok: false, problems: ['currency'] });
    expect(parseDepositForm({ ...form, rail: 'ach' }, NOW)).toEqual({ ok: false, problems: ['currency'] });
    expect(parseDepositForm({ ...form, rail: 'wire', currency: 'USD' }, NOW).ok).toBe(true);
    expect(parseDepositForm({ ...form, valueDate: '2026-11-11', bankReference: '' }, NOW)).toEqual({ ok: false, problems: ['reference', 'date'] });
    expect(parseDepositForm({ ...form, rail: undefined }, NOW)).toEqual({ ok: false, problems: ['rail'] });
  });

  it('the recorder gets no Approve; a second finance member does; support never does', () => {
    expect(canDecide(pending({ recordedByMe: true }), FINN)).toBe(false);
    expect(canDecide(pending(), FERN)).toBe(true);
    expect(canDecide(pending(), SAM)).toBe(false);
    expect(canDecide(pending({ status: 'posted' }), FERN)).toBe(false);
    expect([isFinance(FINN), isFinance(SAM)]).toEqual([true, false]);
  });

  it('a 409 for a reference already used reads as words, as do the other refusals', () => {
    expect(errorWords('CONFLICT')).toMatch(/already recorded on this rail/);
    expect(errorWords('SAME_APPROVER')).toMatch(/different finance member/);
    expect(errorWords(undefined)).toBeUndefined();
    expect(errorWords('<script>')).toBe('Something went wrong. Nothing was recorded; try again.');
  });

  it('the seeded binding keeps the two-person rule: Finn records, Finn cannot decide, Fern approves and the balance rises once', async () => {
    const data = memoryAdminData();
    const [row] = await data.listInstitutions();
    const parsed = parseDepositForm(form, NOW);
    if (!parsed.ok) throw new Error('form');
    const d = await data.recordDeposit(row!.id, parsed.input, FINN, NOW);
    expect((await data.getInstitution(row!.id, FINN))!.deposits[0]).toMatchObject({ id: d.id, recordedByMe: true });
    expect((await data.getInstitution(row!.id, FERN))!.deposits[0]).toMatchObject({ id: d.id, recordedByMe: false });
    await expect(data.recordDeposit(row!.id, { ...parsed.input, key: 'k-2' }, FINN, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(data.recordDeposit(row!.id, { ...parsed.input, bankReference: 'X-1' }, SAM, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(data.decideDeposit(d.id, 'approve', FINN, undefined, NOW)).rejects.toMatchObject({ code: 'SAME_APPROVER' });
    await data.decideDeposit(d.id, 'approve', FERN, undefined, NOW);
    await expect(data.decideDeposit(d.id, 'approve', FERN, undefined, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await data.getInstitution(row!.id, FERN))!.balances).toContainEqual(money(2_000_000n, 'ILS'));
  });
});

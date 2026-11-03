// T-0648 mapping tests (REQ-INS-022, REQ-INS-024): integer cents <-> Money without a float, one table for enum casing,
// ids as strings, the account number cut to four digits, a funder's name split, and a stable UUID for our keys.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { achStatus, applicationStatus, collectedStatus, fromCents, last4, parseRef, ref, splitName, str, toCents, uuidFromKey } from './map.ts';

describe('cents <-> Money', () => {
  it('round-trips 0 and 1, and reads 2^53 + 1 exactly from a string', () => {
    for (const cents of [0, 1, 100, 12_345]) expect(toCents(fromCents(cents))).toBe(cents);
    expect(fromCents('9007199254740993')).toEqual(money(9_007_199_254_740_993n, 'USD'));
    expect(fromCents(9_007_199_254_740_993n).minor).toBe(9_007_199_254_740_993n);
  });

  it('refuses what JSON cannot carry exactly, a fraction, and any other currency', () => {
    expect(() => toCents(money(9_007_199_254_740_993n, 'USD'))).toThrow(/too large/);
    expect(toCents(money(BigInt(Number.MAX_SAFE_INTEGER), 'USD'))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => fromCents(1.5)).toThrow(/whole cents/);
    expect(() => fromCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(/whole cents/);
    expect(() => fromCents('1.50')).toThrow(/whole cents/);
    expect(() => fromCents(100, 'ILS')).toThrow(/USD only/);
    expect(() => toCents(money(100n, 'ILS'))).toThrow(/USD/);
  });
});

describe('ids, names and refs', () => {
  it('every id is a string; an object without one is refused', () => {
    expect([str('a1'), str(42), str('007')]).toEqual(['a1', '42', '007']);
    expect(() => str(undefined)).toThrow(/without an id/);
    expect(() => str('')).toThrow();
  });

  it('keeps four digits of an account number and nothing else', () => {
    expect(last4('0001234567890')).toBe('7890');
    expect(last4(1234567)).toBe('4567');
    expect(() => last4('12')).toThrow();
    expect(() => last4(undefined)).toThrow();
  });

  it('splits a name at its last space', () => {
    expect(splitName('Dana Levi')).toEqual({ firstName: 'Dana', lastName: 'Levi' });
    expect(splitName('  Dana   Ben David  Levi ')).toEqual({ firstName: 'Dana Ben David', lastName: 'Levi' });
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: 'Madonna' });
  });

  it('refs carry the chapter; a malformed ref is NOT_FOUND', () => {
    expect(ref('ch1', 'col2')).toBe('ch1:col2');
    expect(parseRef('ch1:col2', 2)).toEqual(['ch1', 'col2']);
    for (const bad of ['ch1', 'ch1:', 'ch1:a/b', 'ch1:a b', 'a:b:c']) expect(() => parseRef(bad, 2)).toThrow(/Unknown reference/);
  });

  it('our key becomes a stable version-5 UUID', () => {
    const u = uuidFromKey('us-fund:inst:key-0001');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFromKey('us-fund:inst:key-0001')).toBe(u);
    expect(uuidFromKey('us-fund:inst:key-0002')).not.toBe(u);
  });
});

describe('status tables', () => {
  it('application: only Approved opens money; an unknown status reads as pending', () => {
    expect(['Approved', 'Denied', 'Canceled', 'AwaitingDocuments', 'Pending', 'PendingReview', 'FormInProgress', 'Brand New'].map(applicationStatus)).toEqual(['approved', 'rejected', 'rejected', 'needs_info', 'pending', 'pending', 'pending', 'pending']);
  });

  it('ACH: Crowded\'s six statuses; sent is as far as it goes; an unknown status is refused', () => {
    expect(['pending', 'processing', 'sent', 'returned', 'canceled', 'failed', 'Cancelled'].map(achStatus)).toEqual(['pending', 'pending', 'sent', 'returned', 'cancelled', 'rejected', 'cancelled']);
    expect(() => achStatus('settled')).toThrow(/do not know/);
  });

  it('collected payments: only an outcome counts; pending and processing are not yet one', () => {
    expect(['Succeeded', 'Failed', 'Cancelled', 'Returned', 'Refunded', 'Pending', 'Processing', 'Mystery'].map(collectedStatus)).toEqual(['paid', 'declined', 'declined', 'declined', 'refunded', undefined, undefined, undefined]);
  });
});

import { describe, expect, it } from 'vitest';
import { isRecord, str } from './json.ts';

describe('json guards', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
  it('str passes strings (including empty) and drops everything else', () => {
    expect(str('a')).toBe('a');
    expect(str('')).toBe('');
    expect(str(1)).toBeUndefined();
    expect(str(null)).toBeUndefined();
    expect(str({})).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { day, iso } from './dates.ts';

describe('dates', () => {
  it('iso normalises a Date and a string to the same ISO text', () => {
    expect(iso(new Date('2026-03-04T05:06:07.000Z'))).toBe('2026-03-04T05:06:07.000Z');
    expect(iso('2026-03-04T05:06:07Z')).toBe('2026-03-04T05:06:07.000Z');
  });
  it('day cuts a string and reads a Date in UTC', () => {
    expect(day('2026-03-04T23:59:59Z')).toBe('2026-03-04');
    expect(day('2026-03-04')).toBe('2026-03-04');
    expect(day(new Date('2026-03-04T23:59:59.000Z'))).toBe('2026-03-04');
  });
});

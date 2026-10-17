import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isUuid, uuidv7, uuidv7Time } from './ids.ts';

describe('uuidv7', () => {
  it('is a valid v7 UUID that round-trips its timestamp', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (ms) => {
        const id = uuidv7(new Date(ms));
        expect(isUuid(id)).toBe(true);
        expect(id[14]).toBe('7');
        expect(uuidv7Time(id)).toBe(ms);
      }),
    );
  });

  it('sorts by time (lexicographic order follows creation order across milliseconds)', () => {
    const a = uuidv7(new Date(1_000));
    const b = uuidv7(new Date(1_001));
    expect(a < b).toBe(true);
  });

  it('never collides in a burst', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(new Date(5))));
    expect(ids.size).toBe(10_000);
  });
});

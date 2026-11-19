import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isUuid, isUuidShape, uuidv7, uuidv7Time } from './ids.ts';

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

describe('isUuidShape', () => {
  it('accepts any 8-4-4-4-12 hex id, loose ids and upper case included', () => {
    for (const id of ['00000000-0000-0000-0000-000000000001', 'ABCDEF01-2345-6789-ABCD-EF0123456789', uuidv7()]) expect(isUuidShape(id)).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000001')).toBe(false);
  });

  it('rejects wrong length, a missing hyphen, non-hex, and surrounding whitespace', () => {
    for (const bad of [
      '',
      '00000000-0000-0000-0000-00000000000',
      '00000000-0000-0000-0000-0000000000011',
      '000000000000-0000-0000-000000000001',
      '0000000000000000000000000000000001',
      '0000000g-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001\n',
      ' 00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001 ',
    ]) expect(isUuidShape(bad)).toBe(false);
  });
});

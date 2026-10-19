// T-0013 (CLUB-37): the Hebrew copy mirrors the English one key for key and placeholder for
// placeholder, and no Hebrew string forces a run left to right with an embedding or override character.
import { describe, expect, it } from 'vitest';
import { COPY, type CopyKey } from './i18n.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('Hebrew copy (T-0013)', () => {
  it('has every English key, and no key English lacks', () => {
    expect(Object.keys(COPY.he).sort()).toEqual(Object.keys(COPY.en).sort());
  });

  it('keeps the same placeholders in every string, and no string is empty', () => {
    for (const key of Object.keys(COPY.en) as CopyKey[]) {
      expect(placeholders(COPY.he[key]), key).toEqual(placeholders(COPY.en[key]));
      expect(COPY.he[key].trim(), key).not.toBe('');
    }
  });

  it('contains no left-to-right embedding, override or isolate character', () => {
    const LTR_FORCING = /[‪‭⁦]/;
    const offenders = (Object.entries(COPY.he) as [CopyKey, string][]).filter(([, v]) => LTR_FORCING.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

// T-0678: the Hebrew console copy mirrors the English one key for key and placeholder for placeholder, and no Hebrew string
// is English left untranslated (a proper noun or an acronym is listed here, each with its reason).
import { describe, expect, it } from 'vitest';
import { COPY, type CopyKey } from './i18n.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** Hebrew strings that are the same as the English, on purpose. */
const SAME_ON_PURPOSE: ReadonlyMap<CopyKey, string> = new Map<CopyKey, string>([
  ['collections.export.csv', 'a file format name'],
  ['apply.account.iban', 'an international account-number standard, written IBAN in Hebrew too'],
]);

describe('Hebrew console copy (T-0678)', () => {
  it('has every English key and no key English lacks', () => {
    expect(Object.keys(COPY.he).sort()).toEqual(Object.keys(COPY.en).sort());
  });

  it('keeps the same placeholders in every string and no string is empty', () => {
    for (const key of Object.keys(COPY.en) as CopyKey[]) {
      expect(placeholders(COPY.he[key]), key).toEqual(placeholders(COPY.en[key]));
      expect(COPY.he[key].trim(), key).not.toBe('');
    }
  });

  it('no Hebrew string is the English one, except the listed names', () => {
    const same = (Object.keys(COPY.en) as CopyKey[]).filter((k) => COPY.he[k] === COPY.en[k] && /[A-Za-z]{3,}/.test(COPY.en[k].replace(/\{\w+\}/g, '')));
    expect(same.sort()).toEqual([...SAME_ON_PURPOSE.keys()].sort());
  });

  it('a Hebrew sentence does not carry an English phrase of three or more words', () => {
    const offenders = (Object.keys(COPY.he) as CopyKey[]).filter((k) => /\b[A-Za-z]+ [A-Za-z]+ [A-Za-z]+\b/.test(COPY.he[k].replace(/\{\w+\}/g, '')));
    expect(offenders).toEqual([]);
  });
});

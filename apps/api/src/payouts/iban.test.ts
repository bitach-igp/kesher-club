// Payee validation (T-0510, TST-PO-001): the Israeli IBAN checksum, country and shape; the name as the
// bank could know it; the masked display form.
import { describe, expect, it } from 'vitest';
import { checkPayee, maskIban, normalizeIban, normalizeName } from './iban.ts';

const IL = 'IL620108000000099999999';

describe('checkPayee', () => {
  it('accepts a well-formed Israeli IBAN with a plausible name and reports the bank code and last four', () => {
    expect(checkPayee({ iban: 'il62 0108 0000 0009 9999 999', name: '  Yeshivat   Example ' })).toEqual({ ok: true, problems: [], iban: IL, name: 'Yeshivat Example', bankCode: '010', last4: '9999' });
    expect(checkPayee({ iban: IL, name: 'ישיבת דוגמה בע"מ' }).ok).toBe(true);
    expect(checkPayee({ iban: IL, name: "O'Brien & Sons (TLV), Ltd." }).ok).toBe(true);
  });

  it('refuses a bad checksum, a foreign IBAN, a malformed string, and a name that is missing, too long or not a name', () => {
    expect(checkPayee({ iban: 'IL630108000000099999999', name: 'X' }).problems).toEqual(['IBAN_CHECKSUM']);
    expect(checkPayee({ iban: 'DE89370400440532013000', name: 'X' }).problems).toEqual(['NOT_ISRAELI']);
    expect(checkPayee({ iban: 'DE89370400440532013001', name: 'X' }).problems).toEqual(['IBAN_CHECKSUM', 'NOT_ISRAELI']);
    expect(checkPayee({ iban: 'not an iban', name: 'X' }).problems).toEqual(['IBAN_FORMAT']);
    expect(checkPayee({ iban: 12, name: 'X' }).problems).toEqual(['IBAN_FORMAT']);
    expect(checkPayee({ iban: IL, name: '' }).problems).toEqual(['NAME_REQUIRED']);
    expect(checkPayee({ iban: IL, name: undefined }).problems).toEqual(['NAME_REQUIRED']);
    expect(checkPayee({ iban: IL, name: 'x'.repeat(71) }).problems).toEqual(['NAME_TOO_LONG']);
    expect(checkPayee({ iban: IL, name: '<script>alert(1)</script>' }).problems).toEqual(['NAME_INVALID']);
    expect(checkPayee({ iban: IL, name: 'bell\u0007here' }).problems).toEqual(['NAME_INVALID']);
    expect(checkPayee({ iban: 'XX', name: '' }).problems).toEqual(['IBAN_FORMAT', 'NAME_REQUIRED']);
  });

  it('normalises and masks for display', () => {
    expect(normalizeIban(' il62-0108 0000 0009 9999 999 ')).toBe(IL);
    expect(normalizeName('  A   B ')).toBe('A B');
    expect(maskIban(IL)).toBe('IL62 •••• 9999');
  });
});

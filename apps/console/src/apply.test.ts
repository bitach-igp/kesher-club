// T-0633 I01 org onboarding (TST-INS-016 at the screen): each step's fields are checked before the call with the
// API's own rules per market; Submit stays off until all three steps are done and the application may change;
// a retry keeps its key and a new change takes a new one; every status reads as a sentence in both languages,
// and "needs more info" carries the reviewer's reasons; refusals read as sentences.
import { describe, expect, it } from 'vitest';
import { abaOk, accountBody, accountProblem, canSubmit, entityProblem, errorKey, ibanOk, keyFor, signatoryProblem, statusKey, steps, toRequest, type Application, type EntityForm } from './apply.ts';
import { COPY } from './i18n.ts';

const OHR: EntityForm = { legalName: 'Yeshivat Ohr', market: 'IL', registrationNumber: '580123456', line1: '12 HaRav Kook', city: 'Jerusalem', postalCode: '9422712' };
const draft: Application = {
  id: '0190a0a0-0000-7000-8000-000000000a01',
  institutionId: '0190a0a0-0000-7000-8000-000000000a02',
  legalName: 'Yeshivat Ohr',
  market: 'IL',
  registrationNumber: '580123456',
  address: { line1: '12 HaRav Kook', city: 'Jerusalem', postalCode: '9422712' },
  status: 'draft',
  editable: true,
  signatories: [],
  createdAt: '2026-11-10T09:00:00.000Z',
};

describe('T-0633 I01 org onboarding', () => {
  it("checks the entity per market before the call, in the form's order", () => {
    expect(entityProblem(OHR)).toBeUndefined();
    expect(entityProblem({ ...OHR, legalName: ' ' })?.field).toBe('legalName');
    expect(entityProblem({ ...OHR, registrationNumber: '12-3456789' })).toEqual({ field: 'registrationNumber', key: 'apply.entity.registration.il' });
    expect(entityProblem({ ...OHR, market: 'US', registrationNumber: '12-3456789', postalCode: '10001' })).toBeUndefined();
    expect(entityProblem({ ...OHR, postalCode: '94227' })).toEqual({ field: 'postalCode', key: 'apply.entity.postal.il' });
    expect(entityProblem({ ...OHR, market: 'US', registrationNumber: '12345', postalCode: '10001' })?.key).toBe('apply.entity.registration.us');
    expect(entityProblem({ ...OHR, market: 'US', registrationNumber: '123456789', postalCode: '10001' })).toBeUndefined(); // an EIN without its dash
    expect(toRequest({ ...OHR, legalName: '  Yeshivat Ohr ' }).legalName).toBe('Yeshivat Ohr');
  });

  it('checks people and the account before the call: roles, IBAN checksum, routing checksum', () => {
    expect(signatoryProblem({ fullName: 'Rivka Levi', roles: [], self: true })?.key).toBe('apply.people.roles.required');
    expect(signatoryProblem({ fullName: 'Rivka Levi', roles: ['signatory'], self: true })).toBeUndefined();
    expect(ibanOk('IL62 0108 0000 0009 9999 999')).toBe(true);
    expect(ibanOk('IL62 0108 0000 0009 9999 998')).toBe(false);
    expect(accountProblem('IL', { holderName: 'Yeshivat Ohr', iban: 'IL620108000000099999998', routingNumber: '', accountNumber: '' })?.key).toBe('apply.account.iban.invalid');
    expect(abaOk('021000021')).toBe(true);
    expect(accountProblem('US', { holderName: 'Day School', iban: '', routingNumber: '021000022', accountNumber: '1234' })?.key).toBe('apply.account.routing.invalid');
    expect(accountBody('IL', { holderName: ' Yeshivat Ohr ', iban: 'il62 0108 0000 0009 9999 999', routingNumber: '', accountNumber: '' })).toEqual({ holderName: 'Yeshivat Ohr', iban: 'IL620108000000099999999' });
  });

  it('Submit stays off until every step is done, and while the application is with compliance', () => {
    expect(canSubmit(undefined)).toBe(false);
    expect(steps(draft)).toEqual({ entity: true, signatories: false, account: false });
    const board = { ...draft, signatories: [{ id: 'p1', fullName: 'Avi Cohen', roles: ['board' as const], self: false }] };
    expect(steps(board).signatories).toBe(false); // a board member alone signs for nothing
    const ready = { ...board, signatories: [...board.signatories, { id: 'p2', fullName: 'Rivka Levi', roles: ['signatory' as const], self: true }], account: { currency: 'ILS' as const, holderName: 'Yeshivat Ohr', masked: 'IL62 •••• 9999' } };
    expect(canSubmit(ready)).toBe(true);
    expect(canSubmit({ ...ready, status: 'submitted', editable: false })).toBe(false);
    expect(canSubmit({ ...ready, status: 'needs_more_info', editable: true })).toBe(true);
  });

  it('a retry keeps its key; the next change takes a new one', () => {
    const pending = new Map<string, string>();
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const first = keyFor(pending, { person: 'Rivka' }, next);
    expect(keyFor(pending, { person: 'Rivka' }, next).key).toBe(first.key);
    pending.delete(first.change); // it landed
    expect(keyFor(pending, { person: 'Avi' }, next).key).toBe('key-2-00000');
    expect(keyFor(pending, { person: 'Rivka' }, next).key).toBe('key-3-00000');
  });

  it('every status reads as a sentence in both languages; refusals read as sentences', () => {
    for (const status of ['draft', 'submitted', 'needs_more_info', 'approved_with_limits', 'approved', 'rejected'] as const) {
      for (const locale of ['en', 'he'] as const) expect(COPY[locale][statusKey({ ...draft, status })]).toMatch(/\.$/);
    }
    expect(errorKey('VALIDATION_FAILED', ['HOLDER_NOT_ORGANISATION'])).toBe('apply.account.holder.notOrganisation');
    expect(errorKey('VALIDATION_FAILED', ['IBAN_CHECKSUM'])).toBe('apply.account.iban.invalid');
    expect(errorKey('FEATURE_OFF')).toBe('apply.off');
    expect(errorKey('IDEMPOTENCY_CONFLICT')).toBe('apply.conflict');
    expect(errorKey('INTERNAL')).toBe('error.generic');
  });
});

// I01 org onboarding (T-0633, REQ-INS-016): a signed-in person with no institution applies for their
// organisation in three steps (the entity, its signatories, the own-name bank account), each saved as it is
// done, then submits for KYB review. The page then shows where the review stands as a sentence; "needs more
// info" shows the reviewer's reasons and reopens the steps. Every write keeps its Idempotency-Key until it lands,
// so a retry after a lost answer is the same write. The fields are checked here before the API is called, with
// the API's own rules; the API checks again.
import type { Schemas } from '@kesher/sdk';
import type { CopyKey } from './i18n.ts';

export type Application = Schemas['InstitutionApplication'];
export type ApplicationRequest = Schemas['InstitutionApplicationRequest'];
export type Market = 'IL' | 'US';
export type PersonRole = 'board' | 'control' | 'signatory';

export interface EntityForm {
  legalName: string;
  market: Market;
  registrationNumber: string;
  line1: string;
  city: string;
  postalCode: string;
}

export interface SignatoryForm {
  fullName: string;
  roles: PersonRole[];
  self: boolean;
}

export interface AccountForm {
  holderName: string;
  iban: string;
  routingNumber: string;
  accountNumber: string;
}

export type Problem = { field: string; key: CopyKey } | undefined;

const REGISTRATION: Record<Market, RegExp> = { IL: /^\d{9}$/, US: /^\d{2}-?\d{7}$/ };
const POSTAL: Record<Market, RegExp> = { IL: /^\d{7}$/, US: /^\d{5}(?:-\d{4})?$/ };

/** The first problem in form order, or none. */
export function entityProblem(f: EntityForm): Problem {
  if (!f.legalName.trim() || f.legalName.trim().length > 200) return { field: 'legalName', key: 'apply.entity.legalName.required' };
  if (!REGISTRATION[f.market].test(f.registrationNumber.trim())) return { field: 'registrationNumber', key: f.market === 'IL' ? 'apply.entity.registration.il' : 'apply.entity.registration.us' };
  if (!f.line1.trim()) return { field: 'line1', key: 'apply.entity.address.required' };
  if (!f.city.trim()) return { field: 'city', key: 'apply.entity.address.required' };
  if (!POSTAL[f.market].test(f.postalCode.trim())) return { field: 'postalCode', key: f.market === 'IL' ? 'apply.entity.postal.il' : 'apply.entity.postal.us' };
  return undefined;
}

export const toRequest = (f: EntityForm): ApplicationRequest => ({
  legalName: f.legalName.trim(),
  market: f.market,
  registrationNumber: f.registrationNumber.trim(),
  address: { line1: f.line1.trim(), city: f.city.trim(), postalCode: f.postalCode.trim() },
});

export function signatoryProblem(f: SignatoryForm): Problem {
  if (!f.fullName.trim() || f.fullName.trim().length > 200) return { field: 'fullName', key: 'apply.people.name.required' };
  if (!f.roles.length) return { field: 'roles', key: 'apply.people.roles.required' };
  return undefined;
}

/** The ABA routing number's checksum, as the API checks it. */
export function abaOk(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0;
}

/** An IBAN's mod-97 check, after moving the first four characters to the end. */
export function ibanOk(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^IL\d{21}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

export function accountProblem(market: Market, f: AccountForm): Problem {
  if (!f.holderName.trim()) return { field: 'holderName', key: 'apply.account.holder.required' };
  if (market === 'IL') return ibanOk(f.iban) ? undefined : { field: 'iban', key: 'apply.account.iban.invalid' };
  if (!abaOk(f.routingNumber.trim())) return { field: 'routingNumber', key: 'apply.account.routing.invalid' };
  if (!/^\d{4,17}$/.test(f.accountNumber.trim())) return { field: 'accountNumber', key: 'apply.account.number.invalid' };
  return undefined;
}

export const accountBody = (market: Market, f: AccountForm): { holderName: string; iban?: string; routingNumber?: string; accountNumber?: string } =>
  market === 'IL' ? { holderName: f.holderName.trim(), iban: f.iban.replace(/\s+/g, '').toUpperCase() } : { holderName: f.holderName.trim(), routingNumber: f.routingNumber.trim(), accountNumber: f.accountNumber.trim() };

/** Which steps are done; the entity is done once the application exists. */
export function steps(app: Application | undefined): { entity: boolean; signatories: boolean; account: boolean } {
  return { entity: !!app, signatories: !!app?.signatories.some((s) => s.roles.includes('signatory')), account: !!app?.account };
}

/** Submit is offered only on an application that may change and has every step done. */
export function canSubmit(app: Application | undefined): boolean {
  const s = steps(app);
  return !!app && app.editable && s.entity && s.signatories && s.account;
}

/** Where the application stands, as a sentence. */
export const statusKey = (app: Application): CopyKey => `apply.status.${app.status}` as CopyKey;

/** A refusal as a sentence the applicant can act on. */
export function errorKey(code: string, problems?: readonly string[]): CopyKey {
  if (problems?.includes('HOLDER_NOT_ORGANISATION')) return 'apply.account.holder.notOrganisation';
  if (problems?.some((p) => p.startsWith('IBAN') || p === 'NOT_ISRAELI')) return 'apply.account.iban.invalid';
  if (problems?.includes('ROUTING_INVALID')) return 'apply.account.routing.invalid';
  if (code === 'FEATURE_OFF') return 'apply.off';
  if (code === 'IDEMPOTENCY_CONFLICT') return 'apply.conflict';
  if (code === 'VALIDATION_FAILED') return 'apply.invalid';
  if (code === 'NOT_FOUND') return 'error.forbidden';
  return 'error.generic';
}

/**
 * The key a write goes with: the one kept for the same change if it did not land, else a new one. The caller
 * drops it once the write lands, so the next change gets its own.
 */
export function keyFor(pending: Map<string, string>, change: unknown, newKey: () => string): { change: string; key: string } {
  const c = JSON.stringify(change);
  let key = pending.get(c);
  if (!key) pending.set(c, (key = newKey()));
  return { change: c, key };
}

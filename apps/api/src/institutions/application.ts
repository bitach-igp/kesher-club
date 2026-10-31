// Self-serve institution applications (T-0632, REQ-INS-016, decision 2). A signed-in person with no institution
// applies for their organisation in the console (I01):
// - creating the application makes the institution and its first admin, the applicant;
// - while a draft, the applicant records signatories (org.kyb_person, as compliance would) and proposes the bank
//   account, which must be held in the organisation's registered name (REQ-INS-012);
// - submitting opens a `kyb_application` case in the ops queue, where compliance runs the checks and decides
//   (T-0619 to T-0624).
// Nothing here opens money: the KYB gate (REQ-INS-010) keeps deposits, allowances, credit and payouts shut until
// a decision approves. A reviewer's "needs more info" reopens the draft with the reasons, and a resubmit returns it
// to the queue. Insert-only: the status is read from the application's events and the institution's decisions.
// The account is a proposal; compliance still records the verified account from the bank's letter (T-0623).
import { DomainError, uuidv7, type Currency } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';
import { created, ok, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import { ORG_ROLE } from '../admin/institutions.ts';
import { checkPayee, maskIban } from '../payouts/iban.ts';
import type { InstitutionKyb, KybStatus, PersonRole } from './kyb.ts';
import { sameHolder } from './payout-account.ts';

export const SELF_SERVE_FLAG = 'institutions.selfServe';

export type ApplicationStatus = 'draft' | 'submitted' | KybStatus;
export type Market = 'IL' | 'US';

export interface ApplicationAddress {
  line1: string;
  city: string;
  postalCode: string;
}

export interface ProposedAccount {
  currency: Currency;
  holderName: string;
  /** "IL62 •••• 9999" or "•••• 6789": enough to recognise it, never the whole number. */
  masked: string;
}

export interface InstitutionApplication {
  id: string;
  institutionId: string;
  legalName: string;
  market: Market;
  registrationNumber: string;
  address: ApplicationAddress;
  status: ApplicationStatus;
  /** Whether the applicant may still change it: a draft, or sent back for more information. */
  editable: boolean;
  signatories: { id: string; fullName: string; roles: PersonRole[]; self: boolean }[];
  account?: ProposedAccount;
  /** The reviewer's reasons when the application was sent back. */
  reviewerNote?: string[];
  submittedAt?: string;
  createdAt: string;
}

interface AppRow {
  id: string;
  institution_id: string;
  applicant_party_id: string;
  legal_name: string;
  registration_number: string;
  address: ApplicationAddress;
  created_at: string | Date;
  market: Market;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date): string => new Date(v).toISOString();
const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });
const text = (v: unknown, max: number, field: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > max) throw new DomainError('VALIDATION_FAILED', `${field} must be 1 to ${max} characters`);
  return s;
};

/** An Israeli amuta or company number is nine digits; a US EIN is two and seven. */
const REGISTRATION: Record<Market, RegExp> = { IL: /^\d{9}$/, US: /^\d{2}-?\d{7}$/ };
const POSTAL: Record<Market, RegExp> = { IL: /^\d{7}$/, US: /^\d{5}(?:-\d{4})?$/ };
const CURRENCY: Record<Market, Currency> = { IL: 'ILS', US: 'USD' };

/** The ABA routing number's checksum: 3·d1 + 7·d2 + d3 + … ≡ 0 (mod 10). */
export function abaOk(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export function parseApplication(input: Record<string, unknown>): { legalName: string; market: Market; registrationNumber: string; address: ApplicationAddress } {
  const legalName = text(input['legalName'], 200, 'legalName');
  const market = input['market'];
  if (market !== 'IL' && market !== 'US') throw new DomainError('VALIDATION_FAILED', 'market must be IL or US');
  const registrationNumber = text(input['registrationNumber'], 40, 'registrationNumber');
  if (!REGISTRATION[market].test(registrationNumber)) throw new DomainError('VALIDATION_FAILED', market === 'IL' ? 'registrationNumber must be the nine-digit registration number' : 'registrationNumber must be the EIN, NN-NNNNNNN');
  const a = (input['address'] ?? {}) as Record<string, unknown>;
  const address = { line1: text(a['line1'], 120, 'address.line1'), city: text(a['city'], 80, 'address.city'), postalCode: text(a['postalCode'], 10, 'address.postalCode') };
  if (!POSTAL[market].test(address.postalCode)) throw new DomainError('VALIDATION_FAILED', market === 'IL' ? 'address.postalCode must be seven digits' : 'address.postalCode must be a ZIP code');
  return { legalName, market, registrationNumber, address };
}

/** The proposed account, checked: an Israeli IBAN, or a US routing and account number; held in the legal name. */
export function parseAccount(market: Market, legalName: string, input: Record<string, unknown>): { payload: Record<string, unknown>; view: ProposedAccount } {
  const holderName = text(input['holderName'], 200, 'holderName');
  if (!sameHolder(holderName, legalName)) throw new DomainError('VALIDATION_FAILED', "The account must be held in the organisation's registered name", { problems: ['HOLDER_NOT_ORGANISATION'] });
  const currency = CURRENCY[market];
  if (market === 'IL') {
    const check = checkPayee({ iban: input['iban'], name: holderName });
    if (!check.ok) throw new DomainError('VALIDATION_FAILED', 'The IBAN is not a valid Israeli account', { problems: check.problems });
    return { payload: { currency, holderName, iban: check.iban }, view: { currency, holderName, masked: maskIban(check.iban) } };
  }
  const routingNumber = typeof input['routingNumber'] === 'string' ? input['routingNumber'].trim() : '';
  const accountNumber = typeof input['accountNumber'] === 'string' ? input['accountNumber'].trim() : '';
  if (!abaOk(routingNumber)) throw new DomainError('VALIDATION_FAILED', 'routingNumber is not a valid ABA routing number', { problems: ['ROUTING_INVALID'] });
  if (!/^\d{4,17}$/.test(accountNumber)) throw new DomainError('VALIDATION_FAILED', 'accountNumber must be 4 to 17 digits', { problems: ['ACCOUNT_INVALID'] });
  return { payload: { currency, holderName, routingNumber, accountNumber }, view: { currency, holderName, masked: `•••• ${accountNumber.slice(-4)}` } };
}

const viewOfAccount = (p: Record<string, unknown>): ProposedAccount => ({
  currency: p['currency'] as Currency,
  holderName: String(p['holderName']),
  masked: typeof p['iban'] === 'string' ? maskIban(p['iban']) : `•••• ${String(p['accountNumber']).slice(-4)}`,
});

export interface ApplicationDeps {
  db: Database;
  identity: Pick<IdentityRepository, 'findUser' | 'setUserRoles'>;
  flags: FeatureFlags;
  audit: AuditService;
  kyb: Pick<InstitutionKyb, 'addPerson'>;
}

export class InstitutionApplications {
  private readonly d: ApplicationDeps;
  constructor(deps: ApplicationDeps) {
    this.d = deps;
  }

  /** Makes the institution, its application and its first admin, the applicant; a retry with the key answers it. */
  async create(applicant: string, input: Record<string, unknown>, key: string, now: Date): Promise<InstitutionApplication> {
    await this.requireFlag(applicant);
    const a = parseApplication(input);
    const replay = async () => {
      const r = await this.d.db.query<{ id: string; applicant_party_id: string; legal_name: string }>('select id, applicant_party_id, legal_name from org.institution_application where idempotency_key = $1', [key]);
      const row = r.rows[0];
      if (!row) return undefined;
      if (row.applicant_party_id !== applicant || row.legal_name !== a.legalName) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key made a different application');
      return this.view(row.id);
    };
    const seen = await replay();
    if (seen) return seen;
    const staff = await this.d.db.query('select 1 from org.staff where party_id = $1 and active', [applicant]);
    if (staff.rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already staff of an institution');
    const mine = await this.d.db.query('select 1 from org.institution_application where applicant_party_id = $1', [applicant]);
    if (mine.rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'You have already applied for an organisation');

    const institutionId = uuidv7(now);
    const id = uuidv7(now);
    try {
      await this.d.db.transaction(async (tx) => {
        await tx.query('insert into org.institution (id, name, market, created_at) values ($1, $2, $3, $4)', [institutionId, a.legalName, a.market, now]);
        await tx.query('insert into org.institution_onboarding (idempotency_key, institution_id, created_by, created_at) values ($1, $2, $3, $4)', [`apply:${key}`, institutionId, applicant, now]);
        await tx.query('insert into org.institution_application (id, institution_id, applicant_party_id, idempotency_key, legal_name, registration_number, address, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', [id, institutionId, applicant, key, a.legalName, a.registrationNumber, JSON.stringify(a.address), now]);
        // The upsert moves nobody between institutions: an active row elsewhere matches no update.
        const s = await tx.query(
          `insert into org.staff (party_id, institution_id, role, active, created_at) values ($1, $2, 'admin', true, $3)
           on conflict (party_id) do update set institution_id = excluded.institution_id, role = 'admin', active = true where not org.staff.active returning party_id`,
          [applicant, institutionId, now],
        );
        if (!s.rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already staff of an institution');
        await this.d.audit.record({ actorId: applicant, actorRole: 'applicant', action: 'institution.apply', subject: institutionId, reason: 'Self-serve application', after: { name: a.legalName, market: a.market, role: 'admin' } }, now, inTx(tx));
      });
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) {
        const won = await replay();
        if (won) return won;
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'You have already applied for an organisation');
      }
      throw e;
    }
    const user = await this.d.identity.findUser(applicant);
    if (user) await this.d.identity.setUserRoles(applicant, [...user.roles.filter((r) => !r.startsWith('org_')), ORG_ROLE.admin]);
    return this.view(id);
  }

  /** The caller's own application, if they made one. */
  async mine(partyId: string): Promise<InstitutionApplication> {
    const r = await this.d.db.query<{ id: string }>('select id from org.institution_application where applicant_party_id = $1', [partyId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'No application');
    return this.view(r.rows[0].id);
  }

  /** A signatory, board member or control person; `self` links the applicant's own party. */
  async addSignatory(id: string, applicant: string, input: Record<string, unknown>, key: string, now: Date): Promise<InstitutionApplication> {
    const app = await this.editable(id, applicant);
    await this.d.kyb.addPerson(app.institution_id, { fullName: input['fullName'], roles: input['roles'], ...(input['self'] === true ? { partyId: applicant } : {}) }, key, { partyId: applicant, role: 'applicant' }, now);
    return this.view(id);
  }

  /** The bank account the organisation will be paid out to; the latest proposal stands. */
  async proposeAccount(id: string, applicant: string, input: Record<string, unknown>, now: Date): Promise<InstitutionApplication> {
    const app = await this.editable(id, applicant);
    const { payload } = parseAccount(app.market, app.legal_name, input);
    await this.d.db.query(`insert into org.institution_application_event (id, application_id, kind, payload, by_party, at) values ($1, $2, 'account_proposed', $3, $4, $5)`, [uuidv7(now), id, JSON.stringify(payload), applicant, now]);
    return this.view(id);
  }

  /** Sends it to compliance. Submitting a submitted application answers it unchanged. */
  async submit(id: string, applicant: string, now: Date): Promise<InstitutionApplication> {
    await this.requireFlag(applicant);
    const current = await this.view((await this.own(id, applicant)).id);
    if (current.status === 'submitted') return current;
    if (!current.editable) throw new DomainError('IDEMPOTENCY_CONFLICT', `The application is ${current.status.replace(/_/g, ' ')}`);
    const missing = [...(current.signatories.some((s) => s.roles.includes('signatory')) ? [] : ['signatory']), ...(current.account ? [] : ['account'])];
    if (missing.length) throw new DomainError('VALIDATION_FAILED', `Add ${missing.join(' and ')} before submitting`, { missing });
    const eventId = uuidv7(now);
    await this.d.db.transaction(async (tx) => {
      await tx.query(`insert into org.institution_application_event (id, application_id, kind, by_party, at) values ($1, $2, 'submitted', $3, $4)`, [eventId, id, applicant, now]);
      // The legal name is the applicant's text: the case carries it as data.
      await tx.query(
        `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'kyb_application', $2, 'medium', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
        [uuidv7(now), `kyb_application:${eventId}`, JSON.stringify({ institutionId: current.institutionId, applicationId: id, market: current.market, summary: `Self-serve application: ${current.legalName} (${current.market})` }), now],
      );
    });
    return this.view(id);
  }

  async view(id: string): Promise<InstitutionApplication> {
    const r = await this.d.db.query<AppRow>('select a.id, a.institution_id, a.applicant_party_id, a.legal_name, a.registration_number, a.address, a.created_at, i.market from org.institution_application a join org.institution i on i.id = a.institution_id where a.id = $1', [id]);
    const a = r.rows[0];
    if (!a) throw new DomainError('NOT_FOUND', 'Application not found');
    const [events, people, decision] = await Promise.all([
      this.d.db.query<{ kind: 'account_proposed' | 'submitted'; payload: Record<string, unknown>; at: string | Date }>('select kind, payload, at from org.institution_application_event where application_id = $1 order by seq desc', [id]),
      this.d.db.query<{ id: string; full_name: string; roles: PersonRole[]; party_id: string | null }>('select id, full_name, roles, party_id from org.kyb_person where institution_id = $1 order by created_at, id', [a.institution_id]),
      this.d.db.query<{ status: KybStatus; reasons: string[]; decided_at: string | Date }>('select status, reasons, decided_at from org.kyb_decision where institution_id = $1 order by seq desc limit 1', [a.institution_id]),
    ]);
    const submitted = events.rows.find((e) => e.kind === 'submitted');
    const account = events.rows.find((e) => e.kind === 'account_proposed');
    const d = decision.rows[0];
    const decided = submitted && d && new Date(d.decided_at).getTime() >= new Date(submitted.at).getTime() ? d : undefined;
    const status: ApplicationStatus = !submitted ? 'draft' : decided ? decided.status : 'submitted';
    return {
      id: a.id,
      institutionId: a.institution_id,
      legalName: a.legal_name,
      market: a.market,
      registrationNumber: a.registration_number,
      address: a.address,
      status,
      editable: status === 'draft' || status === 'needs_more_info',
      signatories: people.rows.map((p) => ({ id: p.id, fullName: p.full_name, roles: p.roles, self: p.party_id === a.applicant_party_id })),
      ...(account ? { account: viewOfAccount(account.payload) } : {}),
      ...(status === 'needs_more_info' && decided ? { reviewerNote: decided.reasons } : {}),
      ...(submitted ? { submittedAt: iso(submitted.at) } : {}),
      createdAt: iso(a.created_at),
    };
  }

  private async requireFlag(partyId: string): Promise<void> {
    if (!(await this.d.flags.isOn(SELF_SERVE_FLAG, { partyId }))) throw new DomainError('FEATURE_OFF', 'Self-serve applications are not open yet');
  }

  /** The applicant's own application; anyone else's reads as not found. */
  private async own(id: string, applicant: string): Promise<AppRow> {
    const r = UUID.test(id) ? await this.d.db.query<AppRow>('select a.id, a.institution_id, a.applicant_party_id, a.legal_name, a.registration_number, a.address, a.created_at, i.market from org.institution_application a join org.institution i on i.id = a.institution_id where a.id = $1 and a.applicant_party_id = $2', [id, applicant]) : { rows: [] as AppRow[] };
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Application not found');
    return r.rows[0];
  }

  private async editable(id: string, applicant: string): Promise<AppRow> {
    await this.requireFlag(applicant);
    const row = await this.own(id, applicant);
    const v = await this.view(id);
    if (!v.editable) throw new DomainError('IDEMPOTENCY_CONFLICT', `The application is ${v.status.replace(/_/g, ' ')}; it can change only when sent back`);
    return row;
  }
}

export function applicationHandlers(apps: InstitutionApplications): Record<string, Handler> {
  const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
  return {
    createInstitutionApplication: route(async (req) => created(await apps.create(requirePrincipal(req).partyId, body(req.body), requireIdempotencyKey(req), req.now))),
    getMyInstitutionApplication: route(async (req) => ok(await apps.mine(requirePrincipal(req).partyId))),
    addApplicationSignatory: route(async (req) => ok(await apps.addSignatory(req.params['id'] ?? '', requirePrincipal(req).partyId, body(req.body), requireIdempotencyKey(req), req.now))),
    proposeApplicationAccount: route(async (req) => ok(await apps.proposeAccount(req.params['id'] ?? '', requirePrincipal(req).partyId, body(req.body), req.now))),
    submitInstitutionApplication: route(async (req) => ok(await apps.submit(req.params['id'] ?? '', requirePrincipal(req).partyId, req.now))),
  };
}

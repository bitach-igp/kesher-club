// The member's funding details (T-0738, REQ-WAL-002, ADR-018 option 2). The owner contact of the member's sub-account, asked once: legal
// first and last name, email and an optional date of birth; or, instead, an invitation email only (`{ inviteEmail }`). Every value is
// personal data (class P1): sealed by the PII cipher under its column's name, never written, logged, audited or put in an error in plaintext.
// The caller reads and replaces only their own; no KYC is needed to store them. This is not the display name (T-0531): that screen's promise
// ("people paying you see only Avi E.") stays true. `read` is the `OwnerDetailsReader` that SubAccountService (T-0752) takes: the mobile is
// unsealed from the account row, and a member with no row (or no account) has nothing. Nothing here reaches a vendor.
import { DomainError } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import type { PiiCipher } from '../crypto/pii.ts';
import type { Database, SqlClient } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { OwnerDetailsReader, SubAccountOwnerDetails } from '../wallet/sub-accounts.ts';

const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });
const COL = {
  first: 'identity.member_funding_details.first_name',
  last: 'identity.member_funding_details.last_name',
  email: 'identity.member_funding_details.email',
  dob: 'identity.member_funding_details.date_of_birth',
} as const;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
/** The shape the sub-account adapter and its simulator check. */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** Control, format (bidi overrides, zero-width) and separator characters other than an ordinary space. */
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface FundingDetails {
  firstName?: string;
  lastName?: string;
  email?: string;
  dateOfBirth?: string;
  inviteEmail?: string;
  updatedAt: string;
}

export type ParsedFundingDetails =
  | { firstName: string; lastName: string; email: string; dateOfBirth?: string; inviteEmail?: undefined }
  | { inviteEmail: string; firstName?: undefined; lastName?: undefined; email?: undefined; dateOfBirth?: undefined };

const bad = (field: string, message: string): DomainError => new DomainError('VALIDATION_FAILED', message, { field });

const name = (v: unknown, field: string): string => {
  const s = typeof v === 'string' ? v.normalize('NFC').trim() : '';
  if (s.length < 1 || s.length > NAME_MAX || BAD_CHARS.test(s)) throw bad(field, `${field} must be 1 to ${NAME_MAX} characters with no control characters`);
  return s;
};

const email = (v: unknown, field: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > EMAIL_MAX || !EMAIL.test(s) || BAD_CHARS.test(s)) throw bad(field, `${field} is not a valid email address`);
  return s;
};

/** A real calendar date from 1900 to today (UTC), as `YYYY-MM-DD`. */
const dateOfBirth = (v: unknown, today: Date): string => {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const real = new Date(Date.UTC(y, mo - 1, d));
  const valid = m !== null && real.getUTCFullYear() === y && real.getUTCMonth() === mo - 1 && real.getUTCDate() === d;
  if (!valid || y < 1900 || (v as string) > today.toISOString().slice(0, 10)) throw bad('dateOfBirth', 'dateOfBirth must be a real date from 1900 to today (YYYY-MM-DD)');
  return v as string;
};

/** Validates what the member typed. Either an owner (`firstName`, `lastName`, `email`, optional `dateOfBirth`) or an `inviteEmail` alone. */
export function parseFundingDetails(input: Record<string, unknown>, today: Date = new Date()): ParsedFundingDetails {
  if (input.inviteEmail !== undefined) {
    for (const f of ['firstName', 'lastName', 'email', 'dateOfBirth']) if (input[f] !== undefined) throw bad(f === 'email' ? 'inviteEmail' : f, `${f} cannot be sent with inviteEmail`);
    return { inviteEmail: email(input.inviteEmail, 'inviteEmail') };
  }
  const firstName = name(input.firstName, 'firstName');
  const lastName = name(input.lastName, 'lastName');
  const mail = email(input.email, 'email');
  return { firstName, lastName, email: mail, ...(input.dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth(input.dateOfBirth, today) } : {}) };
}

interface Row {
  first_name: Uint8Array | null;
  last_name: Uint8Array | null;
  email: Uint8Array;
  date_of_birth: Uint8Array | null;
  updated_at: string | Date;
}

export class FundingDetailsService implements OwnerDetailsReader {
  private readonly db: Database;
  private readonly pii: PiiCipher;
  private readonly identity: Pick<IdentityRepository, 'findUser'>;
  private readonly audit: AuditService;
  constructor(deps: { db: Database; pii: PiiCipher; identity: Pick<IdentityRepository, 'findUser'>; audit: AuditService }) {
    this.db = deps.db;
    this.pii = deps.pii;
    this.identity = deps.identity;
    this.audit = deps.audit;
  }

  private async load(partyId: string): Promise<Row | undefined> {
    const r = await this.db.query<Row>('select first_name, last_name, email, date_of_birth, updated_at from identity.member_funding_details where party_id = $1', [partyId]);
    return r.rows[0];
  }

  /** The caller's own details; 404 when none are stored. */
  async get(partyId: string): Promise<FundingDetails> {
    const row = await this.load(partyId);
    if (!row) throw new DomainError('NOT_FOUND', 'No funding details are stored yet');
    const mail = this.pii.open(row.email, COL.email);
    const updatedAt = new Date(row.updated_at).toISOString();
    if (!row.first_name || !row.last_name) return { inviteEmail: mail, updatedAt };
    return {
      firstName: this.pii.open(row.first_name, COL.first),
      lastName: this.pii.open(row.last_name, COL.last),
      email: mail,
      ...(row.date_of_birth ? { dateOfBirth: this.pii.open(row.date_of_birth, COL.dob) } : {}),
      updatedAt,
    };
  }

  /** Stores (or replaces) the caller's details. The audit entry names the fields set, never a value. */
  async set(partyId: string, input: Record<string, unknown>, now: Date): Promise<FundingDetails> {
    const p = parseFundingDetails(input, now);
    const fields = p.inviteEmail !== undefined ? ['inviteEmail'] : ['firstName', 'lastName', 'email', ...(p.dateOfBirth ? ['dateOfBirth'] : [])];
    const seal = (v: string | undefined, col: string) => (v === undefined ? null : this.pii.seal(v, col));
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into identity.member_funding_details (party_id, first_name, last_name, email, date_of_birth, updated_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (party_id) do update set first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, date_of_birth = excluded.date_of_birth, updated_at = excluded.updated_at`,
        [partyId, seal(p.firstName, COL.first), seal(p.lastName, COL.last), this.pii.seal(p.inviteEmail ?? p.email!, COL.email), seal(p.dateOfBirth, COL.dob), now],
      );
      await this.audit.record({ actorId: partyId, actorRole: 'member', action: 'member.funding_details.update', subject: partyId, reason: 'member set their funding details', payload: { fields } }, now, inTx(tx));
    });
    return { ...(p.inviteEmail !== undefined ? { inviteEmail: p.inviteEmail } : { firstName: p.firstName!, lastName: p.lastName!, email: p.email!, ...(p.dateOfBirth ? { dateOfBirth: p.dateOfBirth } : {}) }), updatedAt: now.toISOString() };
  }

  /** T-0752's reader: the owner contact with the mobile from the account row, or the invitation email, or nothing. */
  async read(partyId: string): Promise<SubAccountOwnerDetails | undefined> {
    const row = await this.load(partyId);
    if (!row) return undefined;
    const mail = this.pii.open(row.email, COL.email);
    if (!row.first_name || !row.last_name) return { inviteEmail: mail };
    const user = await this.identity.findUser(partyId);
    if (!user) return undefined;
    return {
      owner: {
        firstName: this.pii.open(row.first_name, COL.first),
        lastName: this.pii.open(row.last_name, COL.last),
        email: mail,
        mobile: user.phone,
        ...(row.date_of_birth ? { dateOfBirth: this.pii.open(row.date_of_birth, COL.dob) } : {}),
      },
    };
  }
}

/** GET and PATCH /me/funding-details. */
export function fundingDetailsHandlers(details: FundingDetailsService): Record<string, Handler> {
  return {
    getFundingDetails: route(async (req) => ok(await details.get(requirePrincipal(req).partyId))),
    updateFundingDetails: route(async (req) => ok(await details.set(requirePrincipal(req).partyId, (req.body ?? {}) as Record<string, unknown>, req.now))),
  };
}

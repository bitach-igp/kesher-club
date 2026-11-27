// The recipient profile (T-1101, phase 1 gap analysis): who a member is to Israel. A `category` from a closed set, an optional `program`
// (80 characters: Nefesh B'Nefesh, JNF, Mir and so on) and an optional `israelConnection` statement (280 characters). Both free-text fields
// are the member's own words: untrusted plain text, never treated as instructions and never rendered as markup. They are trimmed, NFC
// normalised, refused when they hold a control, bidi or zero-width character, and sealed at rest by the PII cipher under their column's
// name (personal data, class P1). They are never logged, audited or echoed in an error. Unset reads as `null` in every field, never a
// default. Lengths count Unicode code points after NFC normalisation and trimming (an emoji is 1, "e" plus a combining accent is 1). One current row per member (`identity.recipient_profile`); every real change appends a row to
// `identity.recipient_profile_history` (insert-only, numbered by a per-member `revision`) in the same transaction, under a per-member lock, and a PATCH that changes nothing appends nothing.
// Behind `phase1.recipientProfile`. Bearer only; it moves no money and needs no KYC. Nothing here reaches a vendor.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { PiiCipher } from '../crypto/pii.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';

export const RECIPIENT_PROFILE_FLAG = 'phase1.recipientProfile';
export const RECIPIENT_CATEGORIES = ['soldier', 'lone_soldier', 'yeshiva_student', 'seminary_student', 'university_student', 'rabbi', 'volunteer', 'program_participant', 'other'] as const;
export type RecipientCategory = (typeof RECIPIENT_CATEGORIES)[number];
export const PROGRAM_MAX = 80;
export const CONNECTION_MAX = 280;

const COL = {
  program: 'identity.recipient_profile.program',
  connection: 'identity.recipient_profile.israel_connection',
  hProgram: 'identity.recipient_profile_history.program',
  hConnection: 'identity.recipient_profile_history.israel_connection',
} as const;
/** Control, format (bidi overrides, zero-width) and separator characters, newlines and tabs included: the statement is one plain line of text. */
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const KEYS = new Set(['category', 'program', 'israelConnection']);

export interface RecipientProfile {
  category: RecipientCategory | null;
  program: string | null;
  israelConnection: string | null;
  updatedAt: string | null;
}

/** What a PATCH carries after validation; `null` clears a free-text field. */
export interface RecipientProfilePatch {
  category?: RecipientCategory;
  program?: string | null;
  israelConnection?: string | null;
}

const bad = (field: string, message: string): DomainError => new DomainError('VALIDATION_FAILED', message, { field });

const freeText = (v: unknown, field: string, max: number): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string') throw bad(field, `${field} must be text or null`);
  const s = v.normalize('NFC').trim();
  if (s === '') return null;
  if ([...s].length > max || BAD_CHARS.test(s)) throw bad(field, `${field} must be at most ${max} characters of plain text with no control characters`);
  return s;
};

/** Validates a PATCH body. The message never carries what the member typed. */
export function parseRecipientProfilePatch(body: unknown): RecipientProfilePatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('VALIDATION_FAILED', 'send category, program, israelConnection or any of them');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!KEYS.has(k)) throw bad(k.slice(0, 40), 'unknown field; send category, program or israelConnection');
  if (Object.keys(b).length === 0) throw new DomainError('VALIDATION_FAILED', 'send category, program, israelConnection or any of them');
  const patch: RecipientProfilePatch = {};
  if ('category' in b) {
    if (typeof b.category !== 'string' || !(RECIPIENT_CATEGORIES as readonly string[]).includes(b.category)) throw bad('category', `category must be one of ${RECIPIENT_CATEGORIES.join(', ')}`);
    patch.category = b.category as RecipientCategory;
  }
  if ('program' in b) patch.program = freeText(b.program, 'program', PROGRAM_MAX);
  if ('israelConnection' in b) patch.israelConnection = freeText(b.israelConnection, 'israelConnection', CONNECTION_MAX);
  return patch;
}

interface Row {
  category: RecipientCategory;
  program: Uint8Array | null;
  israel_connection: Uint8Array | null;
  updated_at: string | Date;
}

const UNSET: RecipientProfile = { category: null, program: null, israelConnection: null, updatedAt: null };

export class RecipientProfileService {
  private readonly db: Database;
  private readonly pii: PiiCipher;
  private readonly flags: FeatureFlags;
  constructor(deps: { db: Database; pii: PiiCipher; flags: FeatureFlags }) {
    this.db = deps.db;
    this.pii = deps.pii;
    this.flags = deps.flags;
  }

  async assertOn(partyId: string): Promise<void> {
    if (!(await this.flags.isOn(RECIPIENT_PROFILE_FLAG, { partyId }))) throw new DomainError('FEATURE_OFF', 'The recipient profile is not available yet');
  }

  private view(row: Row): RecipientProfile {
    return {
      category: row.category,
      program: row.program ? this.pii.open(row.program, COL.program) : null,
      israelConnection: row.israel_connection ? this.pii.open(row.israel_connection, COL.connection) : null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /** The caller's own profile; every field `null` until they set one. */
  async get(partyId: string): Promise<RecipientProfile> {
    const r = await this.db.query<Row>('select category, program, israel_connection, updated_at from identity.recipient_profile where party_id = $1', [partyId]);
    return r.rows[0] ? this.view(r.rows[0]) : { ...UNSET };
  }

  /**
   * Sets the fields the patch carries and leaves the others as stored. The first set needs a category. When the result equals what is
   * stored nothing is written, so a repeat adds no history row and keeps `updatedAt`. Otherwise the current row and one history row
   * are written in one transaction.
   */
  async set(partyId: string, patch: RecipientProfilePatch, now: Date): Promise<RecipientProfile> {
    return this.db.transaction(async (tx) => {
      // `for update` locks nothing while the member has no row, so two first PATCHes would both start from "nothing" and the second would
      // overwrite the first. One advisory lock per member (a bigint key, a different keyspace from the audit chain's two-int4 key) is taken
      // first and held to the end of the transaction; the read after it is a fresh statement, so under READ COMMITTED it sees whatever
      // the lock holder committed. Any stronger isolation level would keep an older snapshot, so it is refused rather than trusted.
      const lock = await tx.query<{ level: string }>(`select current_setting('transaction_isolation') as level from (select pg_advisory_xact_lock(hashtextextended('recipient-profile:' || $1::text, 0))) l`, [partyId]);
      if (lock.rows[0]?.level !== 'read committed') throw new Error('recipient profile writes need READ COMMITTED');
      const r = await tx.query<Row>('select category, program, israel_connection, updated_at from identity.recipient_profile where party_id = $1', [partyId]);
      const before = r.rows[0] ? this.view(r.rows[0]) : undefined;
      const category = patch.category ?? before?.category;
      if (!category) throw bad('category', 'category is required the first time');
      const program = 'program' in patch ? (patch.program ?? null) : (before?.program ?? null);
      const israelConnection = 'israelConnection' in patch ? (patch.israelConnection ?? null) : (before?.israelConnection ?? null);
      if (before && before.category === category && before.program === program && before.israelConnection === israelConnection) return before;
      const seal = (v: string | null, col: string) => (v === null ? null : this.pii.seal(v, col));
      await tx.query(
        `insert into identity.recipient_profile (party_id, category, program, israel_connection, updated_at) values ($1, $2, $3, $4, $5)
         on conflict (party_id) do update set category = excluded.category, program = excluded.program, israel_connection = excluded.israel_connection, updated_at = excluded.updated_at`,
        [partyId, category, seal(program, COL.program), seal(israelConnection, COL.connection), now],
      );
      await tx.query(
        `insert into identity.recipient_profile_history (id, party_id, revision, category, program, israel_connection, recorded_at)
         select $1::uuid, $2::uuid, coalesce(max(revision), 0) + 1, $3::text, $4::bytea, $5::bytea, $6::timestamptz from identity.recipient_profile_history where party_id = $2`,
        [uuidv7(now), partyId, category, seal(program, COL.hProgram), seal(israelConnection, COL.hConnection), now],
      );
      return { category, program, israelConnection, updatedAt: now.toISOString() };
    });
  }
}

/** GET and PATCH /me/recipient-profile. The bearer is checked first, then the flag, then the body. */
export function recipientProfileHandlers(svc: RecipientProfileService): Record<string, Handler> {
  return {
    getRecipientProfile: route(async (req) => {
      const p = requirePrincipal(req);
      await svc.assertOn(p.partyId);
      return ok(await svc.get(p.partyId));
    }),
    updateRecipientProfile: route(async (req) => {
      const p = requirePrincipal(req);
      await svc.assertOn(p.partyId);
      return ok(await svc.set(p.partyId, parseRecipientProfilePatch(req.body), req.now));
    }),
  };
}

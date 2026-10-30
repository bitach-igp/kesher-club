// The name others see when they pay a member (T-0531, REQ-PAY-008). The member types a first and a last name
// once; only the first name and the last name's initial are kept, and others see "Avi E.". Nothing else
// about the last name is stored, so a lookup (T-0530) can name a recipient without identifying a stranger.
// Both parts are personal data (class P1): sealed by the PII cipher under their column's name, never written
// or logged in plaintext. The member's own text: shown as text, never interpreted. Bearer only.
import { DomainError } from '@kesher/domain';
import type { PiiCipher } from '../crypto/pii.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';

export const FIRST_NAME_MAX = 40;
const FIRST = 'identity.member_display_name.first_name';
const INITIAL = 'identity.member_display_name.last_initial';
const LAST_NAME_MAX = 80;
/** Letters (any script), combining marks, spaces, hyphens, apostrophes and Hebrew geresh/gershayim; it starts with a letter. */
const NAME = /^\p{L}[\p{L}\p{M}' \-׳״’.]*$/u;

export interface DisplayName {
  /** "Avi E.", or "Avi" with no last name; absent until the member sets one. */
  displayName?: string;
  firstName?: string;
  lastInitial?: string;
  updatedAt?: string;
}

/** "Avi" and "E" read as "Avi E."; a first name alone reads as itself. */
export const formatDisplayName = (firstName: string, lastInitial: string | undefined): string => (lastInitial ? `${firstName} ${lastInitial}.` : firstName);

/** The parts kept from what the member typed: the first name, tidied, and the last name's first letter. */
export function parseName(input: { firstName?: unknown; lastName?: unknown }): { firstName: string; lastInitial?: string } {
  const tidy = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '');
  const firstName = tidy(input.firstName);
  const lastName = tidy(input.lastName);
  if (!firstName || firstName.length > FIRST_NAME_MAX || !NAME.test(firstName)) throw new DomainError('VALIDATION_FAILED', `firstName must be 1 to ${FIRST_NAME_MAX} letters`, { field: 'firstName' });
  if (lastName && (lastName.length > LAST_NAME_MAX || !NAME.test(lastName))) throw new DomainError('VALIDATION_FAILED', 'lastName must be letters', { field: 'lastName' });
  const initial = lastName ? [...lastName][0]!.toLocaleUpperCase() : undefined;
  return { firstName, ...(initial ? { lastInitial: initial } : {}) };
}

export class DisplayNameService {
  private readonly db: Database;
  private readonly pii: PiiCipher;
  constructor(db: Database, pii: PiiCipher) {
    this.db = db;
    this.pii = pii;
  }

  async get(partyId: string): Promise<DisplayName> {
    const r = await this.db.query<{ first_name: Uint8Array; last_initial: Uint8Array | null; updated_at: string | Date }>('select first_name, last_initial, updated_at from identity.member_display_name where party_id = $1', [partyId]);
    const row = r.rows[0];
    if (!row) return {};
    const firstName = this.pii.open(row.first_name, FIRST);
    const lastInitial = row.last_initial ? this.pii.open(row.last_initial, INITIAL) : undefined;
    return { displayName: formatDisplayName(firstName, lastInitial), firstName, ...(lastInitial ? { lastInitial } : {}), updatedAt: new Date(row.updated_at).toISOString() };
  }

  async set(partyId: string, input: { firstName?: unknown; lastName?: unknown }, now: Date): Promise<DisplayName> {
    const { firstName, lastInitial } = parseName(input);
    await this.db.query(
      `insert into identity.member_display_name (party_id, first_name, last_initial, updated_at) values ($1, $2, $3, $4)
       on conflict (party_id) do update set first_name = excluded.first_name, last_initial = excluded.last_initial, updated_at = excluded.updated_at`,
      [partyId, this.pii.seal(firstName, FIRST), lastInitial ? this.pii.seal(lastInitial, INITIAL) : null, now],
    );
    return { displayName: formatDisplayName(firstName, lastInitial), firstName, ...(lastInitial ? { lastInitial } : {}), updatedAt: now.toISOString() };
  }
}

/** GET and PATCH /me/display-name. */
export function displayNameHandlers(names: DisplayNameService): Record<string, Handler> {
  return {
    getDisplayName: route(async (req) => ok(await names.get(requirePrincipal(req).partyId))),
    updateDisplayName: route(async (req) => {
      const p = requirePrincipal(req);
      const b = (req.body ?? {}) as { firstName?: unknown; lastName?: unknown };
      return ok(await names.set(p.partyId, { firstName: b.firstName, lastName: b.lastName }, req.now));
    }),
  };
}

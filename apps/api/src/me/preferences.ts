// Member preferences (T-0514, REQ-PAY-007, ADR-007; T-1020, REQ-UX-002): the receiving currency, which purse money sent to
// the member lands in, and the appearance (`theme`: system, light or dark; one per account, whatever role signs in). USD or ILS converts a send in the other currency at the club rate (T-0515);
// `as_sent`, the default, keeps the sender's currency. Reading and setting need the bearer only: a
// preference moves no money by itself. Unknown values are refused; the row is upserted.
import { DomainError, type Currency } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';

export type ReceiveCurrency = Currency | 'as_sent';
export const RECEIVE_CURRENCIES: readonly ReceiveCurrency[] = ['USD', 'ILS', 'as_sent'];
export const DEFAULT_RECEIVE_CURRENCY: ReceiveCurrency = 'as_sent';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const DEFAULT_THEME: ThemeChoice = 'system';

export interface Preferences {
  receiveCurrency: ReceiveCurrency;
  theme: ThemeChoice;
  updatedAt?: string;
}

export class PreferenceService {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async get(partyId: string): Promise<Preferences> {
    const r = await this.db.query<{ receive_currency: ReceiveCurrency; theme: ThemeChoice; updated_at: string | Date }>('select receive_currency, theme, updated_at from identity.member_preference where party_id = $1', [partyId]);
    const row = r.rows[0];
    return row ? { receiveCurrency: row.receive_currency, theme: row.theme, updatedAt: new Date(row.updated_at).toISOString() } : { receiveCurrency: DEFAULT_RECEIVE_CURRENCY, theme: DEFAULT_THEME };
  }

  /** The purse a send to this member lands in, given the currency it was sent in. */
  async receiveCurrencyOf(partyId: string, sent: Currency): Promise<Currency> {
    const p = await this.get(partyId);
    return p.receiveCurrency === 'as_sent' ? sent : p.receiveCurrency;
  }

  /**
   * Sets the fields the patch carries and leaves the others as stored. A member with no row gets one:
   * a field the first patch leaves out takes its default (`as_sent`, `system`). Returns the row read back.
   */
  async set(partyId: string, patch: { receiveCurrency?: ReceiveCurrency; theme?: ThemeChoice }, now: Date): Promise<Preferences> {
    const { receiveCurrency, theme } = patch;
    if (receiveCurrency === undefined && theme === undefined) throw new DomainError('VALIDATION_FAILED', 'send receiveCurrency, theme or both');
    if (receiveCurrency !== undefined && !RECEIVE_CURRENCIES.includes(receiveCurrency)) throw new DomainError('VALIDATION_FAILED', `receiveCurrency must be one of ${RECEIVE_CURRENCIES.join(', ')}`);
    if (theme !== undefined && !THEME_CHOICES.includes(theme)) throw new DomainError('VALIDATION_FAILED', `theme must be one of ${THEME_CHOICES.join(', ')}`);
    const updates = [...(receiveCurrency !== undefined ? ['receive_currency = excluded.receive_currency'] : []), ...(theme !== undefined ? ['theme = excluded.theme'] : []), 'updated_at = excluded.updated_at'];
    await this.db.query(
      `insert into identity.member_preference (party_id, receive_currency, theme, updated_at) values ($1, $2, $3, $4)
       on conflict (party_id) do update set ${updates.join(', ')}`,
      [partyId, receiveCurrency ?? DEFAULT_RECEIVE_CURRENCY, theme ?? DEFAULT_THEME, now],
    );
    return this.get(partyId);
  }
}

/** GET and PATCH /me/preferences. */
export function preferenceHandlers(preferences: PreferenceService): Record<string, Handler> {
  return {
    getPreferences: route(async (req) => ok(await preferences.get(requirePrincipal(req).partyId))),
    updatePreferences: route(async (req) => {
      const p = requirePrincipal(req);
      const b = req.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new DomainError('VALIDATION_FAILED', 'send receiveCurrency, theme or both');
      const body = b as Record<string, unknown>;
      // A key that is present must hold a string the service then checks; null and numbers are refused, not ignored.
      const field = (key: string): string | undefined => {
        if (!(key in body)) return undefined;
        const v = body[key];
        if (typeof v !== 'string') throw new DomainError('VALIDATION_FAILED', `${key} must be a string`);
        return v;
      };
      const receiveCurrency = field('receiveCurrency');
      const theme = field('theme');
      return ok(await preferences.set(p.partyId, { ...(receiveCurrency !== undefined ? { receiveCurrency: receiveCurrency as ReceiveCurrency } : {}), ...(theme !== undefined ? { theme: theme as ThemeChoice } : {}) }, req.now));
    }),
  };
}

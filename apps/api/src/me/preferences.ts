// Member preferences (T-0514, REQ-PAY-007, ADR-007): the receiving currency, which purse money sent to
// the member lands in. USD or ILS converts a send in the other currency at the club rate (T-0515);
// `as_sent`, the default, keeps the sender's currency. Reading and setting need the bearer only: a
// preference moves no money by itself. Unknown values are refused; the row is upserted.
import { DomainError, type Currency } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';

export type ReceiveCurrency = Currency | 'as_sent';
export const RECEIVE_CURRENCIES: readonly ReceiveCurrency[] = ['USD', 'ILS', 'as_sent'];
export const DEFAULT_RECEIVE_CURRENCY: ReceiveCurrency = 'as_sent';

export interface Preferences {
  receiveCurrency: ReceiveCurrency;
  updatedAt?: string;
}

export class PreferenceService {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async get(partyId: string): Promise<Preferences> {
    const r = await this.db.query<{ receive_currency: ReceiveCurrency; updated_at: string | Date }>('select receive_currency, updated_at from identity.member_preference where party_id = $1', [partyId]);
    const row = r.rows[0];
    return row ? { receiveCurrency: row.receive_currency, updatedAt: new Date(row.updated_at).toISOString() } : { receiveCurrency: DEFAULT_RECEIVE_CURRENCY };
  }

  /** The purse a send to this member lands in, given the currency it was sent in. */
  async receiveCurrencyOf(partyId: string, sent: Currency): Promise<Currency> {
    const p = await this.get(partyId);
    return p.receiveCurrency === 'as_sent' ? sent : p.receiveCurrency;
  }

  async set(partyId: string, receiveCurrency: ReceiveCurrency, now: Date): Promise<Preferences> {
    if (!RECEIVE_CURRENCIES.includes(receiveCurrency)) throw new DomainError('VALIDATION_FAILED', `receiveCurrency must be one of ${RECEIVE_CURRENCIES.join(', ')}`);
    await this.db.query(
      `insert into identity.member_preference (party_id, receive_currency, updated_at) values ($1, $2, $3)
       on conflict (party_id) do update set receive_currency = excluded.receive_currency, updated_at = excluded.updated_at`,
      [partyId, receiveCurrency, now],
    );
    return { receiveCurrency, updatedAt: now.toISOString() };
  }
}

/** GET and PATCH /me/preferences. */
export function preferenceHandlers(preferences: PreferenceService): Record<string, Handler> {
  return {
    getPreferences: route(async (req) => ok(await preferences.get(requirePrincipal(req).partyId))),
    updatePreferences: route(async (req) => {
      const p = requirePrincipal(req);
      const b = (req.body ?? {}) as { receiveCurrency?: unknown };
      if (typeof b.receiveCurrency !== 'string') throw new DomainError('VALIDATION_FAILED', `receiveCurrency must be one of ${RECEIVE_CURRENCIES.join(', ')}`);
      return ok(await preferences.set(p.partyId, b.receiveCurrency as ReceiveCurrency, req.now));
    }),
  };
}

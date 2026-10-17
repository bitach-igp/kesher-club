// Postgres-backed PreferenceStore for the NotifyService (T-0801). Members edit these from
// Settings; security and emergency cannot be opted out of (DB check).
import { DomainError } from '@kesher/domain';
import { DEFAULT_PREFERENCES, type Category, type Channel, type PreferenceStore, type Preferences } from '@kesher/ports';
import type { Database } from '../db.ts';

export class PostgresPreferenceStore implements PreferenceStore {
  constructor(private readonly db: Database) {}

  async get(partyId: string): Promise<Preferences | undefined> {
    const r = await this.db.query<{ channels: Partial<Record<Category, Channel[]>>; opt_out: string[]; time_zone: string; quiet_start: string; quiet_end: string }>('select * from notify.preference where party_id = $1', [partyId]);
    const p = r.rows[0];
    return p ? { channels: p.channels, optOut: p.opt_out as Preferences['optOut'], timeZone: p.time_zone, quietHours: { start: p.quiet_start, end: p.quiet_end } } : undefined;
  }

  async set(partyId: string, prefs: Partial<Preferences>, now: Date): Promise<Preferences> {
    const merged: Preferences = { ...DEFAULT_PREFERENCES, ...(await this.get(partyId)), ...prefs };
    if ((merged.optOut as string[]).some((c) => c === 'security' || c === 'emergency')) throw new DomainError('VALIDATION_FAILED', 'Security and emergency messages cannot be turned off');
    try {
      Intl.DateTimeFormat('en-US', { timeZone: merged.timeZone });
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'Unknown time zone');
    }
    await this.db.query(
      `insert into notify.preference (party_id, channels, opt_out, time_zone, quiet_start, quiet_end, updated_at) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (party_id) do update set channels = excluded.channels, opt_out = excluded.opt_out, time_zone = excluded.time_zone, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = excluded.updated_at`,
      [partyId, JSON.stringify(merged.channels), [...merged.optOut], merged.timeZone, merged.quietHours?.start ?? '23:00', merged.quietHours?.end ?? '07:00', now],
    );
    return merged;
  }
}

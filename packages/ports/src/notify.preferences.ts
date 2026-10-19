// NotifyService (T-0801, REQ-NOT-001): per-user channel preferences and quiet hours
// (23:00–07:00 Asia/Jerusalem) applied before any adapter sends. Security and emergency messages
// bypass both. A deferred message is queued with its release time and sent by `flush()`.
import type { Category, Channel, Delivery, Notification, NotifyPort } from './notify.ts';

export interface Preferences {
  /** Channels the user allows per category; absent category = all channels allowed. */
  channels: Partial<Record<Category, readonly Channel[]>>;
  /** Marketing opt-out etc. Security and emergency cannot be opted out of. */
  optOut: readonly Exclude<Category, 'security' | 'emergency'>[];
  timeZone: string;
  quietHours?: { start: string; end: string };
}

export const DEFAULT_PREFERENCES: Preferences = { channels: {}, optOut: [], timeZone: 'Asia/Jerusalem', quietHours: { start: '23:00', end: '07:00' } };
export const BYPASS_QUIET: ReadonlySet<Category> = new Set(['security', 'emergency']);

export type Outcome = { action: 'sent'; delivery: Delivery } | { action: 'deferred'; releaseAt: string } | { action: 'suppressed'; reason: 'opted_out' | 'channel_not_allowed' };

export interface PreferenceStore {
  get(partyId: string): Promise<Preferences | undefined>;
}

interface Deferred {
  partyId: string;
  notification: Notification;
  idempotencyKey: string;
  releaseAt: number;
}

/** Local wall-clock minutes since midnight in `timeZone`, for `at`. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether `at` falls inside quiet hours, and when they end (next release instant). */
export function quietWindow(at: Date, prefs: Preferences): { quiet: boolean; releaseAt?: Date } {
  if (!prefs.quietHours) return { quiet: false };
  const now = localMinutes(at, prefs.timeZone);
  const start = toMinutes(prefs.quietHours.start);
  const end = toMinutes(prefs.quietHours.end);
  const wraps = start > end;
  const quiet = wraps ? now >= start || now < end : now >= start && now < end;
  if (!quiet) return { quiet: false };
  const minutesUntilEnd = ((end - now) % 1440 + 1440) % 1440;
  return { quiet: true, releaseAt: new Date(at.getTime() + minutesUntilEnd * 60_000) };
}

export class NotifyService {
  private readonly deferred: Deferred[] = [];

  private readonly port: NotifyPort;
  private readonly prefs: PreferenceStore;
  private readonly clock: () => Date;
  constructor(
    port: NotifyPort,
    prefs: PreferenceStore,
    clock: () => Date = () => new Date(),
  ) {
    this.port = port;
    this.prefs = prefs;
    this.clock = clock;
  }

  async send(partyId: string, n: Notification, idempotencyKey: string): Promise<Outcome> {
    const prefs = (await this.prefs.get(partyId)) ?? DEFAULT_PREFERENCES;
    const bypass = BYPASS_QUIET.has(n.category);
    if (!bypass && prefs.optOut.includes(n.category as Exclude<Category, 'security' | 'emergency'>)) return { action: 'suppressed', reason: 'opted_out' };
    const allowed = prefs.channels[n.category];
    if (!bypass && allowed && !allowed.includes(n.channel)) return { action: 'suppressed', reason: 'channel_not_allowed' };
    if (!bypass) {
      const q = quietWindow(this.clock(), prefs);
      if (q.quiet && q.releaseAt) {
        this.deferred.push({ partyId, notification: n, idempotencyKey, releaseAt: q.releaseAt.getTime() });
        return { action: 'deferred', releaseAt: q.releaseAt.toISOString() };
      }
    }
    return { action: 'sent', delivery: await this.port.send(n, idempotencyKey) };
  }

  /** Sends deferred messages whose release time has passed. Returns how many went out. */
  async flush(): Promise<number> {
    const now = this.clock().getTime();
    let sent = 0;
    for (const d of [...this.deferred]) {
      if (d.releaseAt > now) continue;
      this.deferred.splice(this.deferred.indexOf(d), 1);
      await this.port.send(d.notification, d.idempotencyKey);
      sent += 1;
    }
    return sent;
  }

  pending(): number {
    return this.deferred.length;
  }
}

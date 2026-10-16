// Complaint SLA timers (T-0904, REQ-CMP-002): acknowledge within 2 business days, resolve within
// 15; the row turns amber at day 10 and red at day 13 so nobody learns about a breach on day 16.
// Business days are Monday to Friday minus the configured holidays (the bank's calendar).
import type { Complaint } from '../data/types.ts';

export const ACK_BUSINESS_DAYS = 2;
export const RESOLVE_BUSINESS_DAYS = 15;
export const AMBER_AT_DAY = 10;
export const RED_AT_DAY = 13;

const DAY_MS = 86_400_000;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

export interface BusinessCalendar {
  /** ISO dates (YYYY-MM-DD) that do not count. */
  holidays?: ReadonlySet<string> | undefined;
}

export const isBusinessDay = (d: Date, cal: BusinessCalendar = {}): boolean => {
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !(cal.holidays?.has(dateKey(d)) ?? false);
};

/** Whole business days elapsed from `from` to `to` (the day `from` falls on does not count). */
export function businessDaysBetween(from: Date, to: Date, cal: BusinessCalendar = {}): number {
  if (to.getTime() <= from.getTime()) return 0;
  let n = 0;
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor.getTime() < end.getTime()) {
    cursor.setTime(cursor.getTime() + DAY_MS);
    if (isBusinessDay(cursor, cal)) n++;
  }
  return n;
}

/** The end of the Nth business day after `from` (before it, for a negative N). */
export function addBusinessDays(from: Date, days: number, cal: BusinessCalendar = {}): Date {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 23, 59, 59, 999));
  const step = days < 0 ? -1 : 1;
  let left = Math.abs(days);
  while (left > 0) {
    cursor.setTime(cursor.getTime() + step * DAY_MS);
    if (isBusinessDay(cursor, cal)) left--;
  }
  return cursor;
}

export type SlaColour = 'green' | 'amber' | 'red' | 'breached' | 'closed';

export interface ComplaintSla {
  id: string;
  businessDaysOpen: number;
  ackDue: string;
  ackMet: boolean | undefined;
  ackBreached: boolean;
  resolveDue: string;
  resolveColour: SlaColour;
  daysToResolveDeadline: number;
}

export function complaintSla(c: Complaint, now: Date, cal: BusinessCalendar = {}): ComplaintSla {
  const opened = new Date(c.openedAt);
  const closed = c.status === 'resolved' || c.status === 'withdrawn';
  const end = closed && c.resolvedAt ? new Date(c.resolvedAt) : now;
  const businessDaysOpen = businessDaysBetween(opened, end, cal);
  const ackDue = addBusinessDays(opened, ACK_BUSINESS_DAYS, cal);
  const resolveDue = addBusinessDays(opened, RESOLVE_BUSINESS_DAYS, cal);
  const ackMet = c.acknowledgedAt ? new Date(c.acknowledgedAt).getTime() <= ackDue.getTime() : undefined;
  const ackBreached = ackMet === false || (ackMet === undefined && now.getTime() > ackDue.getTime());
  let resolveColour: SlaColour;
  if (closed) resolveColour = 'closed';
  else if (businessDaysOpen > RESOLVE_BUSINESS_DAYS) resolveColour = 'breached';
  else if (businessDaysOpen >= RED_AT_DAY) resolveColour = 'red';
  else if (businessDaysOpen >= AMBER_AT_DAY) resolveColour = 'amber';
  else resolveColour = 'green';
  return { id: c.id, businessDaysOpen, ackDue: ackDue.toISOString(), ackMet, ackBreached, resolveDue: resolveDue.toISOString(), resolveColour, daysToResolveDeadline: RESOLVE_BUSINESS_DAYS - businessDaysOpen };
}

const order: Record<SlaColour, number> = { breached: 0, red: 1, amber: 2, green: 3, closed: 4 };

/** Worst first, then oldest first. */
export function sortBySla(rows: readonly { c: Complaint; sla: ComplaintSla }[]): { c: Complaint; sla: ComplaintSla }[] {
  return [...rows].sort((a, b) => order[a.sla.resolveColour] - order[b.sla.resolveColour] || a.c.openedAt.localeCompare(b.c.openedAt));
}

const csvCell = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  // Formula injection guard: a cell starting with = + - @ is quoted and prefixed so a spreadsheet never evaluates member text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const EXPORT_COLUMNS = ['id', 'party_id', 'channel', 'category', 'summary', 'opened_at', 'acknowledged_at', 'ack_due', 'ack_met', 'resolved_at', 'resolve_due', 'status', 'business_days_open', 'sla_colour', 'owner', 'escalated_to_bank'] as const;

/** The bank's export: one row per complaint with both SLA clocks. Summary is member text, escaped as data. */
export function exportForBank(complaints: readonly Complaint[], now: Date, cal: BusinessCalendar = {}): string {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const c of complaints) {
    const s = complaintSla(c, now, cal);
    lines.push([c.id, c.partyId, c.channel, c.category, c.summary, c.openedAt, c.acknowledgedAt, s.ackDue, s.ackMet, c.resolvedAt, s.resolveDue, c.status, s.businessDaysOpen, s.resolveColour, c.owner, c.escalatedToBank ?? false].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

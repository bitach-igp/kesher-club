// Compliance alert queue (A02): sort by severity then age; decisions carry the admin and a note.
import type { Alert } from '../data/types.ts';

const SEVERITY: Record<Alert['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function queue(alerts: readonly Alert[]): Alert[] {
  return alerts.filter((a) => a.status === 'open' || a.status === 'in_review').sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.openedAt.localeCompare(b.openedAt));
}

export const ALERT_LABEL: Readonly<Record<Alert['kind'], string>> = {
  structuring: 'Structuring',
  sanctions_hit: 'Sanctions hit',
  kyc_manual_review: 'KYC manual review',
  velocity: 'Velocity',
  recon_break: 'Reconciliation break',
};

/** Hours an alert has waited without a decision. */
export const ageHours = (a: Alert, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(a.openedAt)) / 3_600_000));

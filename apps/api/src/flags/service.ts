// Feature flags (T-0905, REQ-ADM-002, ADR-005 shape): config/flags.json is the registry;
// ops.flag_state holds environment overrides. Flipping a money flag (or any flag, in prod) needs
// an approved two-person request; the flip writes the state and the audit entry in one
// transaction. Unknown flag → off. Reads are cached per request, not across requests. A flip to off
// may carry an incident (T-0911): member-facing copy that GET /status shows while the kill switch holds.
import { DomainError } from '@kesher/domain';
import type { Database } from '../db.ts';
import type { ApprovalRequest, ApprovalService } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import { loadRegistry, type FeatureFlags } from '../billing/capabilities.ts';

export const MONEY_FLAG = /^(wallet\.|card\.|p2p\.|fx\.|payouts\.|funding\.|institutions\.money|mcp\.money)/;
export const isMoneyFlag = (key: string): boolean => MONEY_FLAG.test(key);

/** Member-facing copy on a kill-switch flip, plain text, shown by GET /status while the flag stays off. */
export interface Incident {
  key: string;
  title: string;
  body: string;
  since: string;
}
export const INCIDENT_TITLE_MAX = 80;
export const INCIDENT_BODY_MAX = 280;

/** Validates incident copy: only on a switch-off, both parts present and short, no control characters. */
export function parseIncident(value: boolean, raw: unknown): { title: string; body: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (value) throw new DomainError('VALIDATION_FAILED', 'An incident goes with switching a flag off');
  const r = raw as { title?: unknown; body?: unknown };
  const clean = (v: unknown, max: number, name: string) => {
    if (typeof v !== 'string') throw new DomainError('VALIDATION_FAILED', `incident.${name} is required`);
    const s = v.trim();
    // eslint-disable-next-line no-control-regex
    if (!s || s.length > max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s)) throw new DomainError('VALIDATION_FAILED', `incident.${name} must be 1 to ${max} characters of plain text`);
    return s;
  };
  return { title: clean(r.title, INCIDENT_TITLE_MAX, 'title'), body: clean(r.body, INCIDENT_BODY_MAX, 'body') };
}

export interface FlagView {
  key: string;
  value: boolean;
  default: boolean;
  owner: string;
  gates: string;
  money: boolean;
  changedAt?: string;
}

export class FlagService implements FeatureFlags {
  private readonly registry = new Map(loadRegistry().map((r) => [r.key, r]));

  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(
    db: Database,
    approvals: ApprovalService,
    audit: AuditService,
  ) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
  }

  keys(): readonly string[] {
    return [...this.registry.keys()];
  }

  async isOn(key: string): Promise<boolean> {
    const reg = this.registry.get(key);
    if (!reg) return false;
    const r = await this.db.query<{ value: boolean }>('select value from ops.flag_state where key = $1', [key]);
    return r.rows[0]?.value ?? reg.defaultProd;
  }

  async list(): Promise<FlagView[]> {
    const state = await this.db.query<{ key: string; value: boolean; changed_at: string | Date }>('select key, value, changed_at from ops.flag_state');
    const by = new Map(state.rows.map((s) => [s.key, s]));
    return [...this.registry.values()].map((r) => {
      const s = by.get(r.key);
      return { key: r.key, value: s?.value ?? r.defaultProd, default: r.defaultProd, owner: r.owner, gates: r.gates, money: isMoneyFlag(r.key), ...(s ? { changedAt: new Date(s.changed_at).toISOString() } : {}) };
    });
  }

  /** Step 1: an admin proposes a flip. Money flags need a second admin (REQ-ADM-002). */
  async propose(key: string, value: boolean, by: { partyId: string; role: string }, reason: string, now: Date, incidentInput?: unknown) {
    if (!this.registry.has(key)) throw new DomainError('NOT_FOUND', `Unknown flag ${key}; flags live only in config/flags.json`);
    if (by.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only admins change flags');
    const incident = parseIncident(value, incidentInput);
    const current = await this.isOn(key);
    if (current === value) throw new DomainError('IDEMPOTENCY_CONFLICT', `Flag ${key} is already ${value}`);
    const req = await this.approvals.request({ kind: 'flag_flip', subject: await this.subject(key, value, now), scope: 'platform', requestedBy: by, payload: { key, from: current, to: value, reason, ...(incident ? { incident } : {}) } }, now);
    if (req.status !== 'pending' && req.status !== 'awaiting_second_approval') throw new DomainError('IDEMPOTENCY_CONFLICT', `A flip of ${key} from its current state was already ${req.status} today`);
    const afterFirst = req.approvals === 0 ? await this.approvals.decide(req.id, by, 'approve', now, reason) : req;
    if (afterFirst.status === 'approved') await this.flip(key, value, afterFirst.id, by, reason, now);
    return afterFirst;
  }

  /** The open proposal to flip `key` to `value` from its current state, if one is waiting for a second admin. */
  async pendingFlip(key: string, value: boolean, now: Date): Promise<ApprovalRequest | undefined> {
    const open = await this.approvals.find('flag_flip', await this.subject(key, value, now));
    return open && (open.status === 'pending' || open.status === 'awaiting_second_approval') ? open : undefined;
  }

  /**
   * A flip's approval subject names the state being changed (its last flip, or the registry default) and
   * the day: a duplicate proposal from the same state finds the pending one, and every flip after a change
   * is a fresh request. Keyed on the day alone, an on → off → on day handed the second "on" the morning's
   * already-approved request, and one admin flipped the flag.
   */
  private async subject(key: string, value: boolean, now: Date): Promise<string> {
    const since = (await this.db.query<{ changed_at: string | Date }>('select changed_at from ops.flag_state where key = $1', [key])).rows[0]?.changed_at;
    return `${key}:${value}:${since ? new Date(since).toISOString() : 'default'}:${now.toISOString().slice(0, 10)}`;
  }

  /** Flags held off by an approved flip that carried an incident, with when the switch happened. */
  async incidents(): Promise<Incident[]> {
    const r = await this.db.query<{ key: string; changed_at: string | Date; payload: { incident?: { title: string; body: string } } }>(
      `select s.key, s.changed_at, r.payload from ops.flag_state s join ops.approval_request r on r.id = s.approval_id where s.value = false`,
    );
    return r.rows.filter((x) => x.payload.incident).map((x) => ({ key: x.key, title: x.payload.incident!.title, body: x.payload.incident!.body, since: new Date(x.changed_at).toISOString() }));
  }

  /** Step 2: a second, distinct admin approves; the flip happens only then. */
  async approve(requestId: string, by: { partyId: string; role: string }, now: Date) {
    const req = await this.approvals.decide(requestId, by, 'approve', now);
    if (req.status === 'approved') {
      const p = req.payload as { key: string; to: boolean; reason: string };
      await this.flip(p.key, p.to, req.id, by, p.reason, now);
    }
    return req;
  }

  private async flip(key: string, value: boolean, approvalId: string, by: { partyId: string; role: string }, reason: string, now: Date): Promise<void> {
    if (!(await this.approvals.isApproved('flag_flip', (await this.approvals.get(approvalId))!.subject))) throw new DomainError('FORBIDDEN', 'Flip needs an approved request');
    await this.db.transaction(async (tx) => {
      const txDb = { query: tx.query, transaction: async <T>(fn: (c: typeof tx) => Promise<T>) => fn(tx) };
      const before = await txDb.query<{ value: boolean }>('select value from ops.flag_state where key = $1', [key]);
      const entry = await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'flag.flip', subject: key, reason, before: { value: before.rows[0]?.value ?? this.registry.get(key)!.defaultProd }, after: { value }, payload: { approvalId } }, now, txDb);
      await txDb.query(
        `insert into ops.flag_state (key, value, changed_at, approval_id, audit_id) values ($1, $2, $3, $4, $5)
         on conflict (key) do update set value = excluded.value, changed_at = excluded.changed_at, approval_id = excluded.approval_id, audit_id = excluded.audit_id`,
        [key, value, now, approvalId, entry.id],
      );
    });
  }
}

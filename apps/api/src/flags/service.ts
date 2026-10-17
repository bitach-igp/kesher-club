// Feature flags (T-0905, REQ-ADM-002, ADR-005 shape): config/flags.json is the registry;
// ops.flag_state holds environment overrides. Flipping a money flag (or any flag, in prod) needs
// an approved two-person request; the flip writes the state and the audit entry in one
// transaction. Unknown flag → off. Reads are cached per request, not across requests.
import { DomainError } from '@kesher/domain';
import type { Database } from '../db.ts';
import type { ApprovalService } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import { loadRegistry, type FeatureFlags } from '../billing/capabilities.ts';

export const MONEY_FLAG = /^(wallet\.|card\.|p2p\.|fx\.|payouts\.|funding\.|institutions\.money|mcp\.money)/;
export const isMoneyFlag = (key: string): boolean => MONEY_FLAG.test(key);

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

  constructor(
    private readonly db: Database,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
  ) {}

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
  async propose(key: string, value: boolean, by: { partyId: string; role: string }, reason: string, now: Date) {
    if (!this.registry.has(key)) throw new DomainError('NOT_FOUND', `Unknown flag ${key}; flags live only in config/flags.json`);
    if (by.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only admins change flags');
    const current = await this.isOn(key);
    if (current === value) throw new DomainError('IDEMPOTENCY_CONFLICT', `Flag ${key} is already ${value}`);
    const req = await this.approvals.request({ kind: 'flag_flip', subject: `${key}:${value}:${now.toISOString().slice(0, 10)}`, scope: 'platform', requestedBy: by, payload: { key, from: current, to: value, reason } }, now);
    const afterFirst = req.approvals === 0 ? await this.approvals.decide(req.id, by, 'approve', now, reason) : req;
    if (afterFirst.status === 'approved') await this.flip(key, value, afterFirst.id, by, reason, now);
    return afterFirst;
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

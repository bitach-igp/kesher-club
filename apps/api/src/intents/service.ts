// Pending intents (T-1005, REQ-AGT-006, constitution art. 7): T2 tools create an intent, never a
// journal. A human approves in-app with a passkey step-up within 24 h, or it expires. Approval
// starts the money workflow under the member's own session, not the agent's: a P2P intent runs the very
// send a member's POST /transfers runs (T-1008), so eligibility, limits, balance, the new-pair hold and the
// receiving-currency conversion all apply, keyed `intent:{id}` so a second approval finds the same send.
// A refusal leaves the intent pending. Load intents name no funding method yet, so they cannot be approved.
import { createHash } from 'node:crypto';
import { DomainError, fromWire, uuidv7, type Money } from '@kesher/domain';
import type { Database } from '../db.ts';
import type { HttpRequest, Principal } from '../http.ts';
import { assertNotRestricted } from '../auth/recovery.ts';
import type { StepUpService } from '../auth/step-up.ts';
import { requireStepUp } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { P2P_FLAG } from '../p2p/handlers.ts';
import type { P2pSendService } from '../p2p/send.ts';
import type { TransferService, Transfer } from '../transfers/service.ts';

export const INTENT_TTL_MS = 24 * 3_600_000;
/** The money workflow's id for an approved intent (SEQ-04: start(transfer:{intentId})). */
export const intentKey = (intentId: string): string => `intent:${intentId}`;
export type IntentKind = 'p2p' | 'load' | 'limit_change';
export type IntentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingIntent {
  id: string;
  grantId: string;
  partyId: string;
  kind: IntentKind;
  payload: Record<string, unknown>;
  status: IntentStatus;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Human-readable, built server-side from structured fields only (never from agent text). */
  summary: string;
}

interface Row {
  id: string;
  grant_id: string;
  party_id: string;
  kind: IntentKind;
  payload: Record<string, unknown>;
  status: IntentStatus;
  expires_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
}

/**
 * Agent purchases (T-0406, REQ-CRD-008). A processor-side agentic token has no MCP grant, so its
 * intents carry a stable id derived from the token until the agentic-token grant model lands in the
 * ports; `kind` stays `limit_change` (the one-off exception to a card control) because the intent
 * table's kinds are fixed by migration. The payload's `action` tells the two apart.
 */
export const AGENT_PURCHASE_ACTION = 'agent_purchase';
/** How long an approved purchase stays usable by the retrying agent. */
export const AGENT_PURCHASE_APPROVAL_TTL_MS = 60 * 60_000;

export const agentGrantIdFor = (tokenId: string): string => {
  const h = createHash('sha256').update(`agentic-token:${tokenId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface AgentPurchase {
  partyId: string;
  /** Our card id. */
  cardId: string;
  tokenId: string;
  authId: string;
  amount: Money;
  mcc: string;
  country: string;
  /** Merchant text from the processor: untrusted, shown as text. */
  merchantName: string;
}

export class IntentService {
  constructor(
    private readonly db: Database,
    private readonly transfers: TransferService,
    private readonly stepUp: StepUpService,
    private readonly sends: Pick<P2pSendService, 'send'>,
    private readonly flags: Pick<FeatureFlags, 'isOn'>,
    private readonly notify: (partyId: string, intent: PendingIntent) => Promise<void> = async () => undefined,
  ) {}

  async propose(input: { grantId: string; partyId: string; kind: IntentKind; payload: Record<string, unknown> }, now: Date): Promise<PendingIntent> {
    if (input.kind === 'p2p' || input.kind === 'load') {
      const amount = parseMoney(input.payload['amount']);
      if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
      if (input.kind === 'p2p' && typeof input.payload['toPartyId'] !== 'string') throw new DomainError('VALIDATION_FAILED', 'toPartyId required');
    }
    const id = uuidv7(now);
    await this.db.query(`insert into agent.pending_intent (id, grant_id, party_id, kind, payload, status, expires_at) values ($1, $2, $3, $4, $5, 'pending', $6)`, [id, input.grantId, input.partyId, input.kind, JSON.stringify(input.payload), new Date(now.getTime() + INTENT_TTL_MS)]);
    const intent = (await this.get(id))!;
    await this.notify(input.partyId, intent);
    return intent;
  }

  /** POST /intents/{id}/approve: the member (not the agent) approves with a fresh step-up (REQ-AUTH-006). */
  async approve(req: HttpRequest, intentId: string, idempotencyKey: string): Promise<{ intent: PendingIntent; transfer?: Transfer }> {
    const principal = req.principal;
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
    requireStepUp(this.stepUp, req);
    const intent = await this.get(intentId);
    if (!intent || intent.partyId !== principal.partyId) throw new DomainError('NOT_FOUND', 'Intent not found');
    if (intent.status === 'approved') return { intent, ...(await this.execute(intent, req.now)) };
    if (intent.status !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', `Intent is ${intent.status}`);
    if (Date.parse(intent.expiresAt) <= req.now.getTime()) {
      await this.setStatus(intentId, 'expired', req.now);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Intent expired');
    }
    if (intent.kind === 'p2p') assertNotRestricted(principal, 'p2p_send', req.now);
    if (intent.kind !== 'limit_change') await this.grantAllowsMoney(intent.grantId);
    // Money first: a refusal (limit, balance, eligibility) throws before the intent is marked approved.
    const executed = await this.execute(intent, req.now);
    void idempotencyKey; // the intent id is the money key; the HTTP key only dedupes the approval call
    await this.setStatus(intentId, 'approved', req.now, principal.partyId);
    return { intent: (await this.get(intentId))!, ...executed };
  }

  async reject(principal: Principal, intentId: string, now: Date): Promise<PendingIntent> {
    const intent = await this.get(intentId);
    if (!intent || intent.partyId !== principal.partyId) throw new DomainError('NOT_FOUND', 'Intent not found');
    if (intent.status !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', `Intent is ${intent.status}`);
    await this.setStatus(intentId, 'rejected', now, principal.partyId);
    return (await this.get(intentId))!;
  }

  /**
   * Opens (or finds) the pending approval for an agent purchase: one per token, MCC and amount while
   * it is pending, so a retrying agent does not flood the member. Returns the intent and whether it
   * was opened by this call.
   */
  async openAgentPurchase(p: AgentPurchase, now: Date): Promise<{ intent: PendingIntent; opened: boolean }> {
    const existing = await this.db.query<Row>(
      `select * from agent.pending_intent where party_id = $1 and kind = 'limit_change' and status = 'pending' and expires_at > $2
         and payload->>'action' = $3 and payload->>'tokenId' = $4 and payload->>'mcc' = $5 and payload->'amount'->>'minor' = $6 and payload->'amount'->>'currency' = $7
        order by expires_at desc limit 1`,
      [p.partyId, now, AGENT_PURCHASE_ACTION, p.tokenId, p.mcc, p.amount.minor.toString(), p.amount.currency],
    );
    if (existing.rows[0]) return { intent: toIntent(existing.rows[0]), opened: false };
    const id = uuidv7(now);
    const payload = { action: AGENT_PURCHASE_ACTION, cardId: p.cardId, tokenId: p.tokenId, authId: p.authId, amount: { minor: p.amount.minor.toString(), currency: p.amount.currency }, mcc: p.mcc, country: p.country, merchantName: p.merchantName.slice(0, 120) };
    await this.db.query(`insert into agent.pending_intent (id, grant_id, party_id, kind, payload, status, expires_at) values ($1, $2, $3, 'limit_change', $4, 'pending', $5)`, [id, agentGrantIdFor(p.tokenId), p.partyId, JSON.stringify(payload), new Date(now.getTime() + INTENT_TTL_MS)]);
    const intent = (await this.get(id))!;
    await this.notify(p.partyId, intent);
    return { intent, opened: true };
  }

  /** An approval the member gave for this token, MCC and at least this amount, not yet spent and younger than the TTL. */
  async approvedAgentPurchase(partyId: string, tokenId: string, mcc: string, amount: Money, now: Date): Promise<PendingIntent | undefined> {
    const r = await this.db.query<Row>(
      `select * from agent.pending_intent where party_id = $1 and kind = 'limit_change' and status = 'approved' and decided_at > $2
         and payload->>'action' = $3 and payload->>'tokenId' = $4 and payload->>'mcc' = $5 and payload->'amount'->>'currency' = $6
         and (payload->'amount'->>'minor')::bigint >= $7 and payload->>'consumedAuthId' is null
        order by decided_at asc limit 1`,
      [partyId, new Date(now.getTime() - AGENT_PURCHASE_APPROVAL_TTL_MS), AGENT_PURCHASE_ACTION, tokenId, mcc, amount.currency, amount.minor.toString()],
    );
    return r.rows[0] ? toIntent(r.rows[0]) : undefined;
  }

  /** Marks an approval spent by one authorisation; a second authorisation needs a new approval. */
  async consumeAgentPurchase(intentId: string, authId: string): Promise<boolean> {
    const r = await this.db.query(`update agent.pending_intent set payload = payload || jsonb_build_object('consumedAuthId', $2::text) where id = $1 and payload->>'consumedAuthId' is null`, [intentId, authId]);
    return r.rowCount > 0;
  }

  /** Nightly: expire pending intents past their deadline. */
  async expire(now: Date): Promise<number> {
    const r = await this.db.query(`update agent.pending_intent set status = 'expired', decided_at = $1 where status = 'pending' and expires_at <= $1`, [now]);
    return r.rowCount;
  }

  async get(id: string): Promise<PendingIntent | undefined> {
    const r = await this.db.query<Row>('select * from agent.pending_intent where id = $1', [id]);
    return r.rows[0] ? toIntent(r.rows[0]) : undefined;
  }

  async listPending(partyId: string): Promise<PendingIntent[]> {
    const r = await this.db.query<Row>(`select * from agent.pending_intent where party_id = $1 and status = 'pending' order by expires_at`, [partyId]);
    return r.rows.map(toIntent);
  }

  /** The money the intent moves, through the member's own path; a replay finds its transfer by the intent key. */
  private async execute(intent: PendingIntent, now: Date): Promise<{ transfer?: Transfer }> {
    if (intent.kind === 'limit_change') return {};
    if (intent.kind === 'load') throw new DomainError('FEATURE_OFF', 'Loads proposed by your assistant cannot be approved yet');
    if (!(await this.flags.isOn(P2P_FLAG))) throw new DomainError('FEATURE_OFF', 'Member transfers are not enabled yet');
    const { fromPartyId, toPartyId, amount, note } = intent.payload;
    if (fromPartyId !== undefined && fromPartyId !== intent.partyId) throw new DomainError('FORBIDDEN', 'You can approve sends from your own purse only');
    const key = intentKey(intent.id);
    await this.sends.send(intent.partyId, { toPartyId, amount, ...(note !== undefined ? { note } : {}) }, key, now);
    return { transfer: (await this.transfers.byKey(key))! };
  }

  private async grantAllowsMoney(grantId: string): Promise<void> {
    const g = await this.db.query<{ status: string }>('select status from agent.grant where id = $1', [grantId]);
    if (g.rows[0]?.status !== 'active') throw new DomainError('AGENT_NOT_ALLOWED', 'The assistant grant was revoked; the intent cannot be approved');
  }

  private async setStatus(id: string, status: IntentStatus, now: Date, by?: string): Promise<void> {
    await this.db.query('update agent.pending_intent set status = $2, decided_at = $3, decided_by = $4 where id = $1', [id, status, now, by ?? null]);
  }
}

function parseMoney(v: unknown): Money {
  if (!v || typeof v !== 'object') throw new DomainError('VALIDATION_FAILED', 'amount required');
  try {
    return fromWire(v as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency }');
  }
}

function toIntent(r: Row): PendingIntent {
  const p = r.payload;
  const amount = p['amount'] && typeof p['amount'] === 'object' ? (p['amount'] as { minor: string; currency: string }) : undefined;
  const summary =
    r.kind === 'p2p'
      ? `Send ${amount?.currency ?? ''} ${amount?.minor ?? '?'} minor units to member ${String(p['toPartyId'] ?? '').slice(0, 8)}…`
      : r.kind === 'load'
        ? `Load ${amount?.currency ?? ''} ${amount?.minor ?? '?'} minor units`
        : p['action'] === AGENT_PURCHASE_ACTION
          ? `Allow your assistant's card purchase of ${amount?.currency ?? ''} ${amount?.minor ?? '?'} minor units (MCC ${String(p['mcc'] ?? '')})`
          : 'Change a card limit or control';
  return {
    id: r.id,
    grantId: r.grant_id,
    partyId: r.party_id,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    expiresAt: new Date(r.expires_at).toISOString(),
    ...(r.decided_at ? { decidedAt: new Date(r.decided_at).toISOString() } : {}),
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    summary,
  };
}

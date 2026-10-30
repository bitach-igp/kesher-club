// Pending intents (T-1005, REQ-AGT-006, constitution art. 7): T2 tools create an intent, never a
// journal. A human approves in-app with a passkey step-up within 24 h, or it expires. Approval
// starts the money workflow under the member's own session, not the agent's: a P2P intent runs the very
// send a member's POST /transfers runs (T-1008), so eligibility, limits, balance, the new-pair hold and the
// receiving-currency conversion all apply, keyed `intent:{id}` so a second approval finds the same send.
// A load intent (T-1009) runs the member's POST /loads the same way; the agent names no funding method,
// so the approval does, and the intent keeps that choice so a second approval replays the same load.
// A refusal leaves the intent pending. Expiry (T-1010): past 24 h a pending intent is hidden, refused and
// swept to expired, unless its money already started under its key (an approval that crashed before its
// status write): that one is the member's approval, finished as such by a late approval or by the sweep.
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
import { WALLET_FLAG, type LoadService, type LoadView } from '../wallet/loads.ts';

export const INTENT_TTL_MS = 24 * 3_600_000;
const INTENT_KEY_PREFIX = 'intent:';
/** The money workflow's id for an approved intent (SEQ-04: start(transfer:{intentId})). */
export const intentKey = (intentId: string): string => `${INTENT_KEY_PREFIX}${intentId}`;
export type IntentKind = 'p2p' | 'load' | 'limit_change';
export type IntentStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export const INTENT_STATES: readonly IntentStatus[] = ['pending', 'approved', 'rejected', 'expired'];

/** The member's own money paths an approved intent runs. */
export interface IntentMoney {
  p2p: Pick<P2pSendService, 'send'>;
  loads: Pick<LoadService, 'request'>;
}

export interface ApprovalResult {
  intent: PendingIntent;
  transfer?: Transfer;
  /** Load intents: the load the approval started, as POST /loads answers it. */
  load?: LoadView;
}

/** How the member pays for an approved load; stored on the intent under `approval`. */
type LoadChoice = Record<string, unknown>;
const LOAD_CHOICE_FIELDS = ['method', 'paymentMethodId', 'purseCurrency'] as const;

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

/** What the member's app shows (T-1011): structured fields, and the assistant's text set apart as untrusted. */
export type MemberIntentKind = 'send' | 'load' | 'card_purchase' | 'limit_change';
export interface MemberIntentView {
  id: string;
  kind: MemberIntentKind;
  /** As of now: a pending intent past its deadline is `expired`, swept or not. */
  status: IntentStatus;
  amount?: { minor: string; currency: string };
  recipient?: { partyId: string; phoneMasked?: string };
  assistant: { grantId: string; clientId?: string };
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  /** Text the assistant, its client registration or a roster supplied: shown as text, never followed (REQ-AGT-007). */
  untrusted: { clientName?: string; note?: string; recipientName?: string; merchantName?: string };
}

/** Who a recipient is, as the identity store knows them; only the last four digits of the phone leave it. */
export interface PeopleLookup {
  findUser(partyId: string): Promise<{ phone: string } | undefined>;
}

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
  private readonly db: Database;
  private readonly transfers: TransferService;
  private readonly stepUp: StepUpService;
  private readonly money: IntentMoney;
  private readonly flags: Pick<FeatureFlags, 'isOn'>;
  private readonly notify: (partyId: string, intent: PendingIntent) => Promise<void>;
  private readonly people: PeopleLookup | undefined;
  constructor(
    db: Database,
    transfers: TransferService,
    stepUp: StepUpService,
    money: IntentMoney,
    flags: Pick<FeatureFlags, 'isOn'>,
    notify: (partyId: string, intent: PendingIntent) => Promise<void> = async () => undefined,
    people?: PeopleLookup,
  ) {
    this.db = db;
    this.transfers = transfers;
    this.stepUp = stepUp;
    this.money = money;
    this.flags = flags;
    this.notify = notify;
    this.people = people;
  }

  async propose(input: { grantId: string; partyId: string; kind: IntentKind; payload: Record<string, unknown> }, now: Date): Promise<PendingIntent> {
    if (input.kind === 'p2p' || input.kind === 'load') {
      const amount = parseMoney(input.payload['amount']);
      if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
      // A member id, checked now: a phone or a name here would only fail later, at the member's passkey (T-1013).
      if (input.kind === 'p2p' && !(typeof input.payload['toPartyId'] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.payload['toPartyId']))) throw new DomainError('VALIDATION_FAILED', 'toPartyId must be a member id');
    }
    const id = uuidv7(now);
    await this.db.query(`insert into agent.pending_intent (id, grant_id, party_id, kind, payload, status, expires_at) values ($1, $2, $3, $4, $5, 'pending', $6)`, [id, input.grantId, input.partyId, input.kind, JSON.stringify(input.payload), new Date(now.getTime() + INTENT_TTL_MS)]);
    const intent = (await this.get(id))!;
    await this.notify(input.partyId, intent);
    return intent;
  }

  /** POST /intents/{id}/approve: the member (not the agent) approves with a fresh step-up (REQ-AUTH-006). */
  async approve(req: HttpRequest, intentId: string, idempotencyKey: string): Promise<ApprovalResult> {
    const principal = req.principal;
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
    requireStepUp(this.stepUp, req);
    const intent = await this.get(intentId);
    if (!intent || intent.partyId !== principal.partyId) throw new DomainError('NOT_FOUND', 'Intent not found');
    // A replay reuses the first approval's funding choice; one the sweep finished has none stored, so the body's.
    if (intent.status === 'approved') return { intent, ...(await this.execute(intent, (intent.payload['approval'] as LoadChoice | undefined) ?? loadChoice(req.body), req.now)) };
    if (intent.status !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', `Intent is ${intent.status}`);
    // Money already under the key is this approval resuming: finish it, whatever the clock or the grant says now.
    const started = intent.kind !== 'limit_change' && (await this.transfers.byKey(intentKey(intent.id))) !== undefined;
    if (!started) {
      if (Date.parse(intent.expiresAt) <= req.now.getTime()) {
        await this.setStatus(intentId, 'expired', req.now);
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'Intent expired');
      }
      if (intent.kind === 'p2p') assertNotRestricted(principal, 'p2p_send', req.now);
      if (intent.kind !== 'limit_change') await this.grantAllowsMoney(intent.grantId);
    }
    const choice = intent.kind === 'load' ? loadChoice(req.body) : undefined;
    // Money first: a refusal (limit, balance, eligibility) throws before the intent is marked approved.
    const executed = await this.execute(intent, choice, req.now);
    void idempotencyKey; // the intent id is the money key; the HTTP key only dedupes the approval call
    await this.db.query(`update agent.pending_intent set status = 'approved', decided_at = $2, decided_by = $3, payload = payload || $4::jsonb where id = $1`, [intentId, req.now, principal.partyId, JSON.stringify(choice ? { approval: choice } : {})]);
    return { intent: (await this.get(intentId))!, ...executed };
  }

  async reject(principal: Principal, intentId: string, now: Date): Promise<PendingIntent> {
    const intent = await this.get(intentId);
    if (!intent || intent.partyId !== principal.partyId) throw new DomainError('NOT_FOUND', 'Intent not found');
    if (intent.status !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', `Intent is ${intent.status}`);
    // Past its 24 h there is nothing left to decline: it expired, as approve would also find (T-1011).
    if (Date.parse(intent.expiresAt) <= now.getTime()) {
      await this.setStatus(intentId, 'expired', now);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Intent expired');
    }
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

  /**
   * The sweep (worker ExpireIntentsJob): up to `limit` pending intents past their deadline expire, except one
   * whose money started under its key, which is marked approved by the member as of the transfer's creation.
   */
  async expire(now: Date, limit = 500): Promise<{ expired: number; approved: number }> {
    const r = await this.db.query<{ status: IntentStatus }>(
      `with due as (
         select i.id, i.party_id, (select min(t.created_at) from ops.transfer t where t.idempotency_key = $3 || i.id::text) as started_at
           from agent.pending_intent i
          where i.status = 'pending' and i.expires_at <= $1
          order by i.expires_at limit $2
            for update skip locked
       )
       update agent.pending_intent p
          set status = case when due.started_at is null then 'expired' else 'approved' end,
              decided_at = coalesce(due.started_at, $1),
              decided_by = case when due.started_at is null then null else due.party_id end
         from due where p.id = due.id
       returning p.status`,
      [now, limit, INTENT_KEY_PREFIX],
    );
    const approved = r.rows.filter((x) => x.status === 'approved').length;
    return { expired: r.rows.length - approved, approved };
  }

  async get(id: string): Promise<PendingIntent | undefined> {
    const r = await this.db.query<Row>('select * from agent.pending_intent where id = $1', [id]);
    return r.rows[0] ? toIntent(r.rows[0]) : undefined;
  }

  /** What the member can still approve: pending and inside its 24 h, whether or not the sweep has run. */
  async listPending(partyId: string, now: Date): Promise<PendingIntent[]> {
    const r = await this.db.query<Row>(`select * from agent.pending_intent where party_id = $1 and status = 'pending' and expires_at > $2 order by expires_at`, [partyId, now]);
    return r.rows.map(toIntent);
  }

  /** GET /intents (T-1011): the member's own intents, newest first, optionally in one state as of now. */
  async listForMember(partyId: string, state: IntentStatus | undefined, now: Date, limit = 50): Promise<MemberIntentView[]> {
    const r = await this.db.query<ViewRow>(
      `select i.*, g.client_id, c.name as client_name
         from agent.pending_intent i
         left join agent.grant g on g.id = i.grant_id
         left join agent.client c on c.client_id = g.client_id
        where i.party_id = $1
          and ($2::text is null or (case when i.status = 'pending' and i.expires_at <= $3 then 'expired' else i.status end) = $2)
        order by i.expires_at desc
        limit $4`,
      [partyId, state ?? null, now, limit],
    );
    return Promise.all(r.rows.map((row) => this.view(row, now)));
  }

  /** GET /intents/{id} (T-1011): another member's intent does not exist for this one. */
  async getForMember(partyId: string, intentId: string, now: Date): Promise<MemberIntentView> {
    const r = await this.db.query<ViewRow>(
      `select i.*, g.client_id, c.name as client_name
         from agent.pending_intent i
         left join agent.grant g on g.id = i.grant_id
         left join agent.client c on c.client_id = g.client_id
        where i.id = $1 and i.party_id = $2`,
      [intentId, partyId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Intent not found');
    return this.view(r.rows[0], now);
  }

  private async view(r: ViewRow, now: Date): Promise<MemberIntentView> {
    const p = r.payload;
    const expiresAt = new Date(r.expires_at);
    const kind: MemberIntentKind = r.kind === 'p2p' ? 'send' : r.kind === 'load' ? 'load' : p['action'] === AGENT_PURCHASE_ACTION ? 'card_purchase' : 'limit_change';
    const amount = p['amount'] && typeof p['amount'] === 'object' ? (p['amount'] as { minor?: unknown; currency?: unknown }) : undefined;
    const untrusted: MemberIntentView['untrusted'] = {};
    if (r.client_name) untrusted.clientName = r.client_name;
    if (typeof p['note'] === 'string') untrusted.note = p['note'];
    if (kind === 'card_purchase' && typeof p['merchantName'] === 'string') untrusted.merchantName = p['merchantName'];
    let recipient: MemberIntentView['recipient'];
    if (kind === 'send' && typeof p['toPartyId'] === 'string') {
      const to = p['toPartyId'];
      const [roster, user] = await Promise.all([
        this.db.query<{ member_name: string }>('select member_name from org.member where member_party_id = $1 order by updated_at desc limit 1', [to]),
        this.people?.findUser(to),
      ]);
      recipient = { partyId: to, ...(user ? { phoneMasked: `•••• ${user.phone.slice(-4)}` } : {}) };
      if (roster.rows[0]) untrusted.recipientName = roster.rows[0].member_name;
    }
    return {
      id: r.id,
      kind,
      status: r.status === 'pending' && expiresAt.getTime() <= now.getTime() ? 'expired' : r.status,
      ...(amount && typeof amount.minor === 'string' && typeof amount.currency === 'string' ? { amount: { minor: amount.minor, currency: amount.currency } } : {}),
      ...(recipient ? { recipient } : {}),
      assistant: { grantId: r.grant_id, ...(r.client_id ? { clientId: r.client_id } : {}) },
      createdAt: new Date(expiresAt.getTime() - INTENT_TTL_MS).toISOString(),
      expiresAt: expiresAt.toISOString(),
      ...(r.decided_at ? { decidedAt: new Date(r.decided_at).toISOString() } : {}),
      untrusted,
    };
  }

  /** The money the intent moves, through the member's own path; a replay finds its transfer by the intent key. */
  private async execute(intent: PendingIntent, choice: LoadChoice | undefined, now: Date): Promise<Omit<ApprovalResult, 'intent'>> {
    if (intent.kind === 'limit_change') return {};
    const key = intentKey(intent.id);
    if (intent.kind === 'load') {
      if (!(await this.flags.isOn(WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
      // The approver pays; LoadService judges the method and whose purse they may fund.
      const load = await this.money.loads.request(intent.partyId, { memberPartyId: intent.payload['memberPartyId'] ?? intent.partyId, amount: intent.payload['amount'], ...choice }, key, now);
      return { transfer: (await this.transfers.byKey(key))!, load };
    }
    if (!(await this.flags.isOn(P2P_FLAG))) throw new DomainError('FEATURE_OFF', 'Member transfers are not enabled yet');
    const { fromPartyId, toPartyId, amount, note } = intent.payload;
    if (fromPartyId !== undefined && fromPartyId !== intent.partyId) throw new DomainError('FORBIDDEN', 'You can approve sends from your own purse only');
    await this.money.p2p.send(intent.partyId, { toPartyId, amount, ...(note !== undefined ? { note } : {}) }, key, now);
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

/** The funding choice from the approval body; LoadService validates it. */
function loadChoice(body: unknown): LoadChoice {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return Object.fromEntries(LOAD_CHOICE_FIELDS.filter((f) => b[f] !== undefined).map((f) => [f, b[f]]));
}

function parseMoney(v: unknown): Money {
  if (!v || typeof v !== 'object') throw new DomainError('VALIDATION_FAILED', 'amount required');
  try {
    return fromWire(v as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency }');
  }
}

type ViewRow = Row & { client_id: string | null; client_name: string | null };

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

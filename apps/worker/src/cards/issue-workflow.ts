// Virtual card issue workflow (T-0402, REQ-CRD-001): one run per party, id `card-issue:{partyId}`,
// which is also the idempotency key of every activity it calls. Eligibility (flag on, T2 approved),
// cardholder at the processor, card at the processor, our record. A rerun finds the record and returns
// it; a failure half-way is safe to rerun because each processor call carries the same key. Reports
// whether the card was active within 60 s of the approval that unlocked it.
//
// Deterministic over an `activities` interface so Temporal (ADR-002) can host it unchanged; the API's
// CardService implements the interface (apps/api/src/cards/service.ts).
import type { Card } from '@kesher/ports';

export interface IssuedCard {
  id: string;
  processorCardId: string;
  status: string;
  last4: string;
  issuedAt: string;
}

export interface CardIssueActivities {
  eligibility(partyId: string): Promise<{ kycSessionId: string; existing?: IssuedCard }>;
  createCardholder(partyId: string, kycSessionId: string, key: string): Promise<{ cardholderId: string }>;
  issueCard(cardholderId: string, key: string): Promise<Card>;
  recordCard(partyId: string, card: Card, workflowId: string, now: Date): Promise<IssuedCard>;
}

export interface IssueResult {
  workflowId: string;
  card: IssuedCard;
  /** True when the run found a card the first run already recorded. */
  replayed: boolean;
  elapsedMs: number;
  withinSla: boolean;
}

export const ISSUE_SLA_MS = 60_000;
export const workflowId = (partyId: string): string => `card-issue:${partyId}`;

/**
 * @param approvedAt when the T2 decision landed; the SLA clock starts there.
 * @param clock the workflow's notion of now (Temporal supplies its own; tests freeze it).
 */
export async function run(a: CardIssueActivities, partyId: string, approvedAt: Date, clock: () => Date = () => new Date()): Promise<IssueResult> {
  const wf = workflowId(partyId);
  const e = await a.eligibility(partyId);
  let card: IssuedCard;
  let replayed = false;
  if (e.existing) {
    card = e.existing;
    replayed = true;
  } else {
    const { cardholderId } = await a.createCardholder(partyId, e.kycSessionId, `${wf}:cardholder`);
    const issuedCard = await a.issueCard(cardholderId, `${wf}:card`);
    card = await a.recordCard(partyId, issuedCard, wf, clock());
  }
  const elapsedMs = Math.max(0, new Date(card.issuedAt).getTime() - approvedAt.getTime());
  return { workflowId: wf, card, replayed, elapsedMs, withinSla: card.status === 'active' && elapsedMs <= ISSUE_SLA_MS };
}

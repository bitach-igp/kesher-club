// Virtual card issue workflow (T-0402, REQ-CRD-001): keyed card-issue:{partyId}, every processor call
// carrying that key, one card per party however often it runs, and active within 60 s of the approval.
// Runs against the API's CardService over the card-issuing simulator and PGlite, and against a
// scripted activities fake for the failure and replay paths.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { CardIssuingSimulator, KycSimulator, fixedClock, type Card, type CardIssuingPort } from '@kesher/ports';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { CardService } from '@kesher/api/cards/service';
import { KycService } from '@kesher/api/kyc/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { ISSUE_SLA_MS, run, workflowId, type CardIssueActivities } from './issue-workflow.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-01T09:00:00Z');
const clock = fixedClock(NOW.toISOString());
let kyc: KycService;
let kycSim: KycSimulator;
let cardSim: CardIssuingSimulator;
const keysSeen: string[] = [];

async function approvedParty(): Promise<string> {
  const party = uuidv7(NOW);
  const s = await kyc.start(party, 'T2', `kyc:${party}`, NOW);
  const decision = kycSim.decide(s.sessionId, 'approved');
  await kyc.applyDecision({ provider: 'kyc', eventId: `evt:${party}`, receivedAt: NOW.toISOString(), signatureOk: true, payload: { ...decision, eventId: `evt:${party}` } });
  return party;
}

beforeAll(async () => {
  db = await createTestDatabase();
  kycSim = new KycSimulator(clock);
  kyc = new KycService(db, kycSim, 'IL');
  cardSim = new CardIssuingSimulator(clock);
}, 60_000);
afterAll(async () => db.close());

const recording: CardIssuingPort = {
  createCardholder: (i, k) => (keysSeen.push(k), cardSim.createCardholder(i, k)),
  issueCard: (i, k) => (keysSeen.push(k), cardSim.issueCard(i, k)),
  setStatus: (c, s, k) => cardSim.setStatus(c, s, k),
  updateControls: (c, s, k) => cardSim.updateControls(c, s, k),
  getCard: (c) => cardSim.getCard(c),
  showDetailsToken: (c) => cardSim.showDetailsToken(c),
  activate: (c, i, k) => cardSim.activate(c, i, k),
  parseAuthorization: (h, b) => cardSim.parseAuthorization(h, b),
  encodeDecision: (d) => cardSim.encodeDecision(d),
};

describe('card-issue:{partyId} (TST-CRD-001)', () => {
  it('issues an active virtual card within the SLA, every processor call keyed by the workflow id', async () => {
    const svc = new CardService(db, recording, kyc, new StaticFlags(undefined, { 'card.virtual': true }));
    const party = await approvedParty();
    const approvedAt = new Date(NOW.getTime() - 10_000);
    const r = await run(svc, party, approvedAt, () => NOW);
    expect(r).toMatchObject({ workflowId: `card-issue:${party}`, replayed: false, elapsedMs: 10_000, withinSla: true });
    expect(r.card.status).toBe('active');
    expect(keysSeen.filter((k) => k.startsWith(workflowId(party)))).toEqual([`${workflowId(party)}:cardholder`, `${workflowId(party)}:card`]);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from cards.card where party_id = $1`, [party])).rows[0]).toEqual({ n: 1 });
  });

  it('a rerun replays the recorded card and makes no processor call', async () => {
    const svc = new CardService(db, recording, kyc, new StaticFlags(undefined, { 'card.virtual': true }));
    const party = await approvedParty();
    const first = await run(svc, party, NOW, () => NOW);
    const before = keysSeen.length;
    const again = await run(svc, party, NOW, () => new Date(NOW.getTime() + 120_000));
    expect(again.card.id).toBe(first.card.id);
    expect(again.replayed).toBe(true);
    expect(keysSeen.length).toBe(before);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from cards.card where party_id = $1`, [party])).rows[0]).toEqual({ n: 1 });
  });

  it('refuses before T2 approval and while the flag is off, without touching the processor', async () => {
    const before = keysSeen.length;
    const on = new CardService(db, recording, kyc, new StaticFlags(undefined, { 'card.virtual': true }));
    await expect(run(on, uuidv7(NOW), NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const off = new CardService(db, recording, kyc, new StaticFlags());
    await expect(run(off, await approvedParty(), NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect(keysSeen.length).toBe(before);
  });

  it('a failure after the cardholder exists is retried with the same keys and ends with one card', async () => {
    let issueCalls = 0;
    const card: Card = { cardId: 'card_x', cardholderId: 'ch_x', type: 'virtual', status: 'active', last4: 'rd_x', currency: 'USD', controls: { blockedMccs: [], atm: false, online: true, agentPurchases: 'off' } };
    const recorded = new Map<string, { id: string; processorCardId: string; status: string; last4: string; issuedAt: string }>();
    const a: CardIssueActivities = {
      eligibility: async (p) => ({ kycSessionId: 'kyc_1', ...(recorded.has(p) ? { existing: recorded.get(p)! } : {}) }),
      createCardholder: async (_p, _s, key) => {
        expect(key).toMatch(/:cardholder$/);
        return { cardholderId: 'ch_x' };
      },
      issueCard: async (_c, key) => {
        expect(key).toMatch(/:card$/);
        if (++issueCalls === 1) throw new Error('processor timeout');
        return card;
      },
      recordCard: async (p, c, wf, now) => {
        const rec = { id: uuidv7(now), processorCardId: c.cardId, status: c.status, last4: c.last4, issuedAt: now.toISOString() };
        recorded.set(p, rec);
        expect(wf).toBe(workflowId(p));
        return rec;
      },
    };
    const party = uuidv7(NOW);
    await expect(run(a, party, NOW, () => NOW)).rejects.toThrow('processor timeout');
    expect(recorded.size).toBe(0);
    const r = await run(a, party, NOW, () => new Date(NOW.getTime() + 61_000));
    expect(r.replayed).toBe(false);
    expect(recorded.size).toBe(1);
    // Issued after the 60 s window: the card exists but the SLA was missed, and the report says so.
    expect(r).toMatchObject({ elapsedMs: 61_000, withinSla: false });
    expect(ISSUE_SLA_MS).toBe(60_000);
  });
});

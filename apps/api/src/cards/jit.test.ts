// JIT authorisation (T-0403, REQ-CRD-003) end to end: the processor's signed request through
// POST /jit/card-authorizations, every decline reason, the hold journal on approval, replay, the
// plan's card entitlement, the velocity rule, and the fail-closed paths (a throw, a slow dependency).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainError, money, uuidv7, type Money } from '@kesher/domain';
import { type CardIssuingPort, type CardIssuingSimulator, type JitAuthorizationRequest } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import type { Database } from '../db.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { CARD_SPEND_ENTITLEMENT, DECISION_BUDGET_MS, firstSpendLimitHit, holdKey, JitService, VELOCITY_LIMIT_PER_MINUTE, type SpendLimitHit } from './jit.ts';
import { AGENT_PURCHASE_ACTION, agentGrantIdFor } from '../intents/service.ts';
import { provisionAuthorisationSystemAccounts } from '../ledger/accounts.ts';
import { controlsToWire, DEFAULT_VIRTUAL_CONTROLS } from './service.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
let sim: CardIssuingSimulator;
const NOW = new Date('2026-11-01T09:00:00Z');
const noa = uuidv7(NOW);
let processorCardId = '';
let cardId = '';
let wallet = '';
let pending = '';

type Decision = { result: 'APPROVED'; holdAmount: { minor: string; currency: string } } | { result: 'DECLINED'; reason: string };
const MERCHANT = { name: 'Super-Pharm', mcc: '5912', country: 'IL' };

async function authorize(input: { merchantName?: string; amount: bigint; currency?: 'USD' | 'ILS'; mcc?: string; country?: string; channel?: 'pos' | 'online' | 'atm'; tokenId?: string; agentic?: boolean; card?: string; signature?: string; now?: Date }) {
  const signed = sim.authorize(input.card ?? processorCardId, { amount: { minor: input.amount, currency: input.currency ?? 'ILS' }, merchant: { ...MERCHANT, name: input.merchantName ?? MERCHANT.name, mcc: input.mcc ?? MERCHANT.mcc, country: input.country ?? MERCHANT.country }, channel: input.channel ?? 'pos', ...(input.tokenId ? { tokenId: input.tokenId } : {}), ...(input.agentic ? { agentic: true } : {}) });
  const r = await dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: { ...signed.headers, ...(input.signature ? { 'x-sim-signature': input.signature } : {}) }, rawBody: signed.rawBody, now: input.now ?? NOW });
  return { status: r.status, body: r.body as Decision, authId: (JSON.parse(signed.rawBody) as { authId: string }).authId };
}
const bal = async (account: string) => -(await app.services.ledger.balance(account, 'ILS'));
const setControls = (controls: Parameters<typeof controlsToWire>[0]) => db.query(`update cards.card set controls = $2 where id = $1`, [cardId, JSON.stringify(controlsToWire(controls))]);

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  sim = host.registry.resolve<CardIssuingPort>('card-issuing', 'IL') as CardIssuingSimulator;
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true, 'card.agentic': true }) });
  const s = await app.services.kyc.start(noa, 'T2', 'kyc-noa', NOW);
  await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-noa', sessionId: s.sessionId, status: 'approved' }), now: NOW });
  const row = (await db.query<{ id: string; processor_card_id: string }>(`select id, processor_card_id from cards.card where party_id = $1`, [noa])).rows[0]!;
  cardId = row.id;
  processorCardId = row.processor_card_id;
  wallet = await app.services.accounts.memberAccount(noa, 'wallet', 'ILS');
  pending = await app.services.accounts.memberAccount(noa, 'pending', 'ILS');
  const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
  await app.services.ledger.post({ idempotencyKey: 'load:noa', kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 50_000n }, { accountId: wallet, currency: 'ILS', amountMinor: -50_000n }] });
}, 60_000);
afterAll(async () => db.close());

describe('approve (TST-CRD-003)', () => {
  it('posts one hold journal wallet → pending keyed by the authorisation id, and a replay answers the same without a second hold', async () => {
    const r = await authorize({ amount: 1_800n });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: 'APPROVED', holdAmount: { minor: '1800', currency: 'ILS' } });
    expect(await bal(wallet)).toBe(48_200n);
    expect(await bal(pending)).toBe(1_800n);
    const j = await db.query<{ kind: string; metadata: Record<string, unknown> }>(`select kind, metadata from ledger.journal where idempotency_key = $1`, [holdKey(r.authId)]);
    expect(j.rows[0]).toMatchObject({ kind: 'auth_hold', metadata: { cardId, authId: r.authId, mcc: '5912', country: 'IL', channel: 'pos' } });
    // The processor retries the same authorisation: same answer, still one journal.
    const signed = sim.authorize(processorCardId, { amount: { minor: 1_800n, currency: 'ILS' }, merchant: MERCHANT, channel: 'pos' });
    const replayBody = { ...(JSON.parse(signed.rawBody) as Record<string, unknown>), authId: r.authId };
    const replay = await dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: signed.headers, rawBody: JSON.stringify(replayBody), now: NOW });
    expect(replay.body).toEqual({ result: 'APPROVED', holdAmount: { minor: '1800', currency: 'ILS' } });
    expect(await bal(pending)).toBe(1_800n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where kind = 'auth_hold'`)).rows[0]).toEqual({ n: 1 });
  });
});

describe('declines', () => {
  it('INSUFFICIENT_FUNDS when the purse cannot cover the amount; nothing is held', async () => {
    const before = await bal(pending);
    expect((await authorize({ amount: 100_000n })).body).toEqual({ result: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' });
    expect(await bal(pending)).toBe(before);
  });

  it('T-0544: a wallet drained between the early balance read and the hold is declined INSUFFICIENT_FUNDS where it posts; nothing is held', async () => {
    const real = app.services.ledger.postNoOverdraft.bind(app.services.ledger);
    const spy = vi.spyOn(app.services.ledger, 'postNoOverdraft').mockImplementationOnce(async (input, guard) => {
      // The race: another authorisation spends the whole purse after this one passed the early check.
      const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
      const have = await app.services.ledger.balance(wallet, 'ILS');
      await app.services.ledger.post({ idempotencyKey: `drain:${input.idempotencyKey}`, kind: 'p2p', postings: [{ accountId: wallet, currency: 'ILS', amountMinor: -have }, { accountId: partner, currency: 'ILS', amountMinor: have }] });
      return real(input, guard);
    });
    const before = await bal(pending);
    const r = await authorize({ amount: 1_000n });
    spy.mockRestore();
    expect(r.body).toEqual({ result: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' });
    expect(await bal(pending)).toBe(before);
    // Put the purse back for the tests that follow.
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: 'refill:noa', kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 50_000n }, { accountId: wallet, currency: 'ILS', amountMinor: -50_000n }] });
  });

  it('LIMIT_EXCEEDED against the daily and monthly limits, counting what is already held today', async () => {
    await setControls({ ...DEFAULT_VIRTUAL_CONTROLS, dailyLimit: money(2_000n, 'ILS') });
    expect((await authorize({ amount: 300n })).body).toEqual({ result: 'DECLINED', reason: 'LIMIT_EXCEEDED' }); // 1,800 held + 300 > 2,000
    expect((await authorize({ amount: 200n })).body).toMatchObject({ result: 'APPROVED' });
    await setControls({ ...DEFAULT_VIRTUAL_CONTROLS, monthlyLimit: money(2_000n, 'ILS') });
    expect((await authorize({ amount: 1n })).body).toEqual({ result: 'DECLINED', reason: 'LIMIT_EXCEEDED' });
    // A limit in another currency does not apply to this purse.
    await setControls({ ...DEFAULT_VIRTUAL_CONTROLS, dailyLimit: money(1n, 'USD') });
    expect((await authorize({ amount: 100n })).body).toMatchObject({ result: 'APPROVED' });
    await setControls(DEFAULT_VIRTUAL_CONTROLS);
  });

  it('MCC_BLOCKED, COUNTRY_BLOCKED and CHANNEL_BLOCKED from the controls', async () => {
    await setControls({ ...DEFAULT_VIRTUAL_CONTROLS, blockedMccs: ['7995'], allowedCountries: ['IL', 'US'] });
    expect((await authorize({ amount: 100n, mcc: '7995' })).body).toEqual({ result: 'DECLINED', reason: 'MCC_BLOCKED' });
    expect((await authorize({ amount: 100n, country: 'FR' })).body).toEqual({ result: 'DECLINED', reason: 'COUNTRY_BLOCKED' });
    expect((await authorize({ amount: 100n, channel: 'atm' })).body).toEqual({ result: 'DECLINED', reason: 'CHANNEL_BLOCKED' });
    await setControls({ ...DEFAULT_VIRTUAL_CONTROLS, online: false });
    expect((await authorize({ amount: 100n, channel: 'online' })).body).toEqual({ result: 'DECLINED', reason: 'CHANNEL_BLOCKED' });
    expect((await authorize({ amount: 100n, channel: 'pos' })).body).toMatchObject({ result: 'APPROVED' });
    await setControls(DEFAULT_VIRTUAL_CONTROLS);
  });

  it('AGENT_NOT_ALLOWED for an agentic token while the mode is off; a human token on the same card is fine', async () => {
    expect((await authorize({ amount: 100n, agentic: true, tokenId: 'tok_agent' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    expect((await authorize({ amount: 100n, tokenId: 'tok_1' })).body).toMatchObject({ result: 'APPROVED' });
  });

  it('CARD_FROZEN for a frozen or inactive card, UNKNOWN_CARD for a closed or unknown one', async () => {
    await db.query(`update cards.card set status = 'frozen' where id = $1`, [cardId]);
    expect((await authorize({ amount: 100n })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
    await db.query(`update cards.card set status = 'inactive' where id = $1`, [cardId]);
    expect((await authorize({ amount: 100n })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
    await db.query(`update cards.card set status = 'closed' where id = $1`, [cardId]);
    expect((await authorize({ amount: 100n })).body).toEqual({ result: 'DECLINED', reason: 'UNKNOWN_CARD' });
    await db.query(`update cards.card set status = 'active' where id = $1`, [cardId]);
    expect((await authorize({ amount: 100n, card: 'card_999999' })).body).toEqual({ result: 'DECLINED', reason: 'UNKNOWN_CARD' });
  });

  it('a forged signature is 401 and nothing is decided', async () => {
    const before = await bal(pending);
    const r = await authorize({ amount: 100n, signature: 'forged' });
    expect(r.status).toBe(401);
    expect(await bal(pending)).toBe(before);
  });

  it('LIMIT_EXCEEDED when the plan caps card spend and the cap is reached; the entitlement is consumed on approval', async () => {
    await app.services.plans.ensurePlan('club', 'Kesher Club');
    await app.services.plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: { [CARD_SPEND_ENTITLEMENT]: { limit: '1000', unit: 'minor', period: 'month' } }, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const m = await app.services.memberships.create({ idempotencyKey: 'm-noa', memberPartyId: noa, funderPartyId: uuidv7(NOW), funderEmail: 'f@example.com', planCode: 'club' }, NOW);
    await app.services.memberships.setStatus(m.id, 'active', NOW);
    expect((await authorize({ amount: 600n })).body).toMatchObject({ result: 'APPROVED' });
    expect((await authorize({ amount: 600n })).body).toEqual({ result: 'DECLINED', reason: 'LIMIT_EXCEEDED' });
    expect((await authorize({ amount: 400n })).body).toMatchObject({ result: 'APPROVED' });
    await db.query(`update billing.membership set status = 'cancelled' where id = $1`, [m.id]);
  });

  it('the velocity rule declines the eleventh approval within a minute', async () => {
    const fresh = uuidv7(NOW);
    const s = await app.services.kyc.start(fresh, 'T2', `kyc:${fresh}`, NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt:${fresh}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
    const card = (await db.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1`, [fresh])).rows[0]!.processor_card_id;
    const w = await app.services.accounts.memberAccount(fresh, 'wallet', 'ILS');
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: `load:${fresh}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 100_000n }, { accountId: w, currency: 'ILS', amountMinor: -100_000n }] });
    for (let i = 0; i < VELOCITY_LIMIT_PER_MINUTE; i++) expect((await authorize({ amount: 10n, card })).body).toMatchObject({ result: 'APPROVED' });
    expect((await authorize({ amount: 10n, card })).body).toEqual({ result: 'DECLINED', reason: 'LIMIT_EXCEEDED' });
    expect((await authorize({ amount: 10n, card, now: new Date(NOW.getTime() + 61_000) })).body).toMatchObject({ result: 'APPROVED' });
  });
});

describe('fail closed', () => {
  const request = (): JitAuthorizationRequest => ({ authId: uuidv7(NOW), cardId: processorCardId, amount: money(100n, 'ILS'), merchant: MERCHANT, channel: 'pos', receivedAt: NOW.toISOString() });

  it('any throw inside the decision is a TIMEOUT decline, never an approval or a 500', async () => {
    const broken = new JitService({ db: { query: async () => { throw new Error('connection reset'); }, transaction: async () => { throw new Error('connection reset'); } }, port: sim, ledger: app.services.ledger, accounts: app.services.accounts, memberships: app.services.memberships, entitlements: app.services.entitlements, plans: app.services.plans, flags: app.services.flags, intents: app.services.intents });
    const out = await broken.decide(request(), NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'TIMEOUT' });
    const signed = sim.authorize(processorCardId, { amount: { minor: 100n, currency: 'ILS' }, merchant: MERCHANT, channel: 'pos' });
    const r = await broken.handle(signed.headers, signed.rawBody, NOW);
    expect(r).toMatchObject({ status: 200, body: { result: 'DECLINED', reason: 'TIMEOUT' } });
  });

  it('a dependency slower than the budget is a TIMEOUT decline within the budget', async () => {
    const slowDb = { query: (text: string, params?: readonly unknown[]) => new Promise<never>(() => void [text, params]), transaction: async () => { throw new Error('unused'); } };
    const slow = new JitService({ db: slowDb, port: sim, ledger: app.services.ledger, accounts: app.services.accounts, memberships: app.services.memberships, entitlements: app.services.entitlements, plans: app.services.plans, flags: app.services.flags, intents: app.services.intents, budgetMs: 40 });
    const started = performance.now();
    const out = await slow.decide(request(), NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(DECISION_BUDGET_MS);
    expect(DECISION_BUDGET_MS).toBeLessThan(300);
  });

  it('a non-positive amount is declined without touching the ledger', async () => {
    const out = await app.services.jit.decide({ ...request(), amount: money(0n, 'ILS') }, NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'LIMIT_EXCEEDED' });
    expect(out.journalId).toBeUndefined();
  });
});

describe('freeze and tokens (TST-CRD-004)', () => {
  it('a suspended or deleted wallet token is declined CARD_FROZEN on an active card; an unknown token is the processor\u2019s to know', async () => {
    await db.query(`insert into cards.card_token (token_id, card_id, wallet, device_id, status) values ('tok_susp', $1, 'apple', 'iphone-9', 'suspended'), ('tok_gone', $1, 'google', 'pixel-9', 'deleted'), ('tok_live', $1, 'apple', 'iphone-8', 'active')`, [cardId]);
    expect((await authorize({ amount: 10n, tokenId: 'tok_susp' })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
    expect((await authorize({ amount: 10n, tokenId: 'tok_gone' })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
    expect((await authorize({ amount: 10n, tokenId: 'tok_live' })).body).toMatchObject({ result: 'APPROVED' });
    expect((await authorize({ amount: 10n, tokenId: 'tok_unknown' })).body).toMatchObject({ result: 'APPROVED' });
  });

  it('a freeze through the card service declines the next authorisation and suspends the live token; unfreezing restores both', async () => {
    const frozen = await app.services.cards.setStatus(noa, cardId, 'frozen', 'jit-freeze', NOW);
    expect(frozen.tokens.find((t) => t.deviceId === 'iphone-8')?.status).toBe('suspended');
    expect((await authorize({ amount: 10n })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
    expect((await authorize({ amount: 10n, tokenId: 'tok_live' })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
    await app.services.cards.setStatus(noa, cardId, 'active', 'jit-unfreeze', NOW);
    expect((await authorize({ amount: 10n, tokenId: 'tok_live' })).body).toMatchObject({ result: 'APPROVED' });
    expect((await authorize({ amount: 10n, tokenId: 'tok_susp' })).body).toEqual({ result: 'DECLINED', reason: 'CARD_FROZEN' });
  });
});

describe('agent purchases (TST-CRD-008)', () => {
  // A fresh card so the velocity rule and earlier holds stay out of the way; USD is the card's currency.
  let agentParty = '';
  let agentCard = '';
  let agentCardId = '';
  const agentAuth = (input: Parameters<typeof authorize>[0]) => authorize({ ...input, card: agentCard, agentic: true, tokenId: input.tokenId ?? 'tok_agent_1' });

  beforeAll(async () => {
    agentParty = uuidv7(NOW);
    const s = await app.services.kyc.start(agentParty, 'T2', `kyc:${agentParty}`, NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt:${agentParty}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
    const row = (await db.query<{ id: string; processor_card_id: string }>(`select id, processor_card_id from cards.card where party_id = $1`, [agentParty])).rows[0]!;
    agentCard = row.processor_card_id;
    agentCardId = row.id;
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'USD');
    const w = await app.services.accounts.memberAccount(agentParty, 'wallet', 'USD');
    await app.services.ledger.post({ idempotencyKey: `load:${agentParty}:usd`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 100_000n }, { accountId: w, currency: 'USD', amountMinor: -100_000n }] });
    const partnerIls = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    const wIls = await app.services.accounts.memberAccount(agentParty, 'wallet', 'ILS');
    await app.services.ledger.post({ idempotencyKey: `load:${agentParty}:ils`, kind: 'load', postings: [{ accountId: partnerIls, currency: 'ILS', amountMinor: 100_000n }, { accountId: wIls, currency: 'ILS', amountMinor: -100_000n }] });
  });
  const mode = (agentPurchases: Parameters<typeof controlsToWire>[0]['agentPurchases']) => db.query(`update cards.card set controls = $2 where id = $1`, [agentCardId, JSON.stringify(controlsToWire({ ...DEFAULT_VIRTUAL_CONTROLS, agentPurchases }))]);
  const pendingIntents = () => app.services.intents.listPending(agentParty, NOW);

  it('mode off declines AGENT_NOT_ALLOWED and opens nothing; a human token on the same card is fine', async () => {
    await mode('off');
    expect((await agentAuth({ amount: 1_000n, currency: 'USD' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    expect((await authorize({ amount: 1_000n, currency: 'USD', card: agentCard })).body).toMatchObject({ result: 'APPROVED' });
    expect(await pendingIntents()).toEqual([]);
  });

  it('the card.agentic flag is the kill switch whatever the mode', async () => {
    await mode({ underMinor: 5_000n });
    const off = new JitService({ db, port: sim, ledger: app.services.ledger, accounts: app.services.accounts, memberships: app.services.memberships, entitlements: app.services.entitlements, plans: app.services.plans, flags: new StaticFlags(), intents: app.services.intents });
    const out = await off.decide({ authId: uuidv7(NOW), cardId: agentCard, amount: money(100n, 'USD'), merchant: MERCHANT, channel: 'online', agentic: true, tokenId: 'tok_agent_1', receivedAt: NOW.toISOString() }, NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'AGENT_NOT_ALLOWED' });
    expect(await pendingIntents()).toEqual([]);
  });

  it('under_amount approves below the threshold in the card\u2019s currency only; above it, or in another currency, it asks', async () => {
    await mode({ underMinor: 5_000n });
    expect((await agentAuth({ amount: 4_999n, currency: 'USD' })).body).toMatchObject({ result: 'APPROVED' });
    expect((await agentAuth({ amount: 5_000n, currency: 'USD' })).body).toMatchObject({ result: 'APPROVED' });
    expect((await agentAuth({ amount: 5_001n, currency: 'USD' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    expect((await agentAuth({ amount: 100n, currency: 'ILS' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    const pending = await pendingIntents();
    expect(pending.map((i) => [i.kind, i.payload['action'], (i.payload['amount'] as { minor: string }).minor])).toEqual([
      ['limit_change', AGENT_PURCHASE_ACTION, '5001'],
      ['limit_change', AGENT_PURCHASE_ACTION, '100'],
    ]);
    expect(pending[0]!.summary).toBe("Allow your assistant's card purchase of USD 5001 minor units (MCC 5912)");
    expect(pending[0]!.grantId).toBe(agentGrantIdFor('tok_agent_1'));
    expect(pending[0]!.grantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('with_approval opens one pending intent per token, MCC and amount, declines until approved, then one authorisation spends the approval', async () => {
    await mode('with_approval');
    await db.query(`update agent.pending_intent set status = 'expired' where party_id = $1`, [agentParty]);
    const first = await agentAuth({ amount: 2_500n, currency: 'USD', tokenId: 'tok_agent_2' });
    expect(first.body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    // The agent retries: same ask, still declined, still one intent.
    expect((await agentAuth({ amount: 2_500n, currency: 'USD', tokenId: 'tok_agent_2' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    const pending = await pendingIntents();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toMatchObject({ action: AGENT_PURCHASE_ACTION, tokenId: 'tok_agent_2', mcc: '5912', merchantName: 'Super-Pharm', cardId: agentCardId });
    // The member approves in the app (the approval endpoint's step-up and ownership checks are TST-AGT-006's).
    await db.query(`update agent.pending_intent set status = 'approved', decided_at = $2, decided_by = $3 where id = $1`, [pending[0]!.id, NOW, agentParty]);
    // A different MCC or a larger amount is not what was approved.
    expect((await agentAuth({ amount: 2_500n, currency: 'USD', tokenId: 'tok_agent_2', mcc: '7995' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    expect((await agentAuth({ amount: 2_600n, currency: 'USD', tokenId: 'tok_agent_2' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    // The approved purchase (a smaller final amount is fine) goes through once; the next one asks again.
    const spent = await agentAuth({ amount: 2_400n, currency: 'USD', tokenId: 'tok_agent_2' });
    expect(spent.body).toEqual({ result: 'APPROVED', holdAmount: { minor: '2400', currency: 'USD' } });
    const consumed = await app.services.intents.get(pending[0]!.id);
    expect(consumed?.payload['consumedAuthId']).toBe(spent.authId);
    expect((await agentAuth({ amount: 2_400n, currency: 'USD', tokenId: 'tok_agent_2' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
    // Each distinct ask (token, MCC, amount) the member has not approved is one pending intent: the
    // other MCC, the larger amount, and the repeat after the approval was spent.
    const asks = (await pendingIntents()).map((i) => `${i.payload['mcc']}:${(i.payload['amount'] as { minor: string }).minor}`).sort();
    expect(asks).toEqual(['5912:2400', '5912:2600', '7995:2500']);
    // An approval older than its TTL is not spent.
    const stale = (await pendingIntents()).find((i) => (i.payload['amount'] as { minor: string }).minor === '2400')!;
    await db.query(`update agent.pending_intent set status = 'approved', decided_at = $2, decided_by = $3 where id = $1`, [stale.id, new Date(NOW.getTime() - 2 * 3_600_000), agentParty]);
    expect((await agentAuth({ amount: 2_400n, currency: 'USD', tokenId: 'tok_agent_2' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
  });

  describe('an approved purchase is single-use and bound to its merchant (T-1018, F45)', () => {
    /** The agent asks (declined), the member says yes in the app: returns the approved intent's id. */
    const approvedFor = async (tokenId: string, minor: bigint, extra: { merchantName?: string; country?: string } = {}) => {
      await mode('with_approval');
      expect((await agentAuth({ amount: minor, currency: 'USD', tokenId, ...extra })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
      const intent = (await pendingIntents()).find((i) => i.payload['tokenId'] === tokenId)!;
      await db.query(`update agent.pending_intent set status = 'approved', decided_at = $2, decided_by = $3 where id = $1`, [intent.id, NOW, agentParty]);
      return intent.id;
    };

    it('another merchant, or the same name in another country, is not what was approved; the right merchant still is', async () => {
      await db.query(`update agent.pending_intent set status = 'expired' where party_id = $1`, [agentParty]);
      const id = await approvedFor('tok_agent_m1', 45_000n, { merchantName: 'Hotel One' });
      for (const other of [{ merchantName: 'Hotel Two' }, { merchantName: 'Hotel One', country: 'US' }]) {
        expect((await agentAuth({ amount: 45_000n, currency: 'USD', tokenId: 'tok_agent_m1', ...other })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
      }
      expect((await app.services.intents.get(id))?.payload['consumedAuthId']).toBeUndefined();
      expect((await agentAuth({ amount: 45_000n, currency: 'USD', tokenId: 'tok_agent_m1', merchantName: 'Hotel One' })).body).toMatchObject({ result: 'APPROVED' });
    });

    it('two authorisations racing for one approval: exactly one is approved, one hold is posted', async () => {
      await db.query(`update agent.pending_intent set status = 'expired' where party_id = $1`, [agentParty]);
      const id = await approvedFor('tok_agent_m2', 3_000n);
      const [a, b] = await Promise.all([agentAuth({ amount: 3_000n, currency: 'USD', tokenId: 'tok_agent_m2' }), agentAuth({ amount: 3_000n, currency: 'USD', tokenId: 'tok_agent_m2' })]);
      expect([a.body, b.body].filter((x) => x.result === 'APPROVED')).toHaveLength(1);
      const winner = a.body.result === 'APPROVED' ? a : b;
      expect((await app.services.intents.get(id))?.payload['consumedAuthId']).toBe(winner.authId);
      expect((await db.query(`select 1 from ledger.journal where idempotency_key = any($1::text[])`, [[`jit:${a.authId}`, `jit:${b.authId}`]])).rows.length).toBe(1);
    });

    it('a hold that is refused, by a funds check or by any other error, gives the approval back', async () => {
      await db.query(`update agent.pending_intent set status = 'expired' where party_id = $1`, [agentParty]);
      const id = await approvedFor('tok_agent_m3', 2_000n);
      for (const failure of [new DomainError('INSUFFICIENT_FUNDS', 'no', { available: '0', currency: 'USD' }), new Error('database went away')]) {
        const spy = vi.spyOn(app.services.ledger, 'postNoOverdraft').mockRejectedValueOnce(failure);
        const r = await agentAuth({ amount: 2_000n, currency: 'USD', tokenId: 'tok_agent_m3' });
        spy.mockRestore();
        expect(r.body).toMatchObject({ result: 'DECLINED' });
        expect((await app.services.intents.get(id))?.payload['consumedAuthId']).toBeUndefined();
      }
      expect((await agentAuth({ amount: 2_000n, currency: 'USD', tokenId: 'tok_agent_m3' })).body).toMatchObject({ result: 'APPROVED' });
    });

    it('an amount above the approval is declined; a long merchant name matches the 120 characters stored', async () => {
      await db.query(`update agent.pending_intent set status = 'expired' where party_id = $1`, [agentParty]);
      const merchantName = 'H'.repeat(130);
      const id = await approvedFor('tok_agent_m4', 1_500n, { merchantName });
      expect((await agentAuth({ amount: 1_501n, currency: 'USD', tokenId: 'tok_agent_m4', merchantName })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
      expect((await app.services.intents.get(id))?.payload['consumedAuthId']).toBeUndefined();
      expect((await agentAuth({ amount: 1_500n, currency: 'USD', tokenId: 'tok_agent_m4', merchantName })).body).toMatchObject({ result: 'APPROVED' });
    });

    it('while one authorisation holds the approval a different one is declined, and the same one asking again is approved without a second hold', async () => {
      await db.query(`update agent.pending_intent set status = 'expired' where party_id = $1`, [agentParty]);
      const id = await approvedFor('tok_agent_m5', 1_200n);
      const signed = sim.authorize(agentCard, { amount: { minor: 1_200n, currency: 'USD' }, merchant: MERCHANT, channel: 'pos', tokenId: 'tok_agent_m5', agentic: true });
      const authId = (JSON.parse(signed.rawBody) as { authId: string }).authId;
      // The state a crash between spending the approval and posting the hold leaves behind.
      await db.query(`update agent.pending_intent set payload = payload || jsonb_build_object('consumedAuthId', $2::text) where id = $1`, [id, authId]);
      expect((await agentAuth({ amount: 1_200n, currency: 'USD', tokenId: 'tok_agent_m5' })).body).toEqual({ result: 'DECLINED', reason: 'AGENT_NOT_ALLOWED' });
      const again = () => dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: signed.headers, rawBody: signed.rawBody, now: NOW });
      expect((await again()).body).toMatchObject({ result: 'APPROVED' });
      expect((await again()).body).toMatchObject({ result: 'APPROVED' });
      expect((await db.query(`select 1 from ledger.journal where idempotency_key = $1`, [`jit:${authId}`])).rows).toHaveLength(1);
    });
  });
});

describe('which purse pays (T-0409, ADR-007)', () => {
  const ari = uuidv7(new Date(NOW.getTime() + 1));
  let ariCard = '';
  let ariIls = '';
  let ariUsd = '';
  const credit = async (account: string, currency: 'USD' | 'ILS', minor: bigint, key: string) => {
    const partner = await app.services.accounts.systemAccount('partner_settlement', currency);
    await app.services.ledger.post({ idempotencyKey: key, kind: 'load', postings: [{ accountId: partner, currency, amountMinor: minor }, { accountId: account, currency, amountMinor: -minor }] });
  };
  const holdPostings = async (authId: string) =>
    (
      await db.query<{ type: string; currency: string; amount_minor: string }>(
        `select a.type::text, p.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id where j.idempotency_key = $1 order by p.amount_minor desc`,
        [holdKey(authId)],
      )
    ).rows;
  const usdPay = (minor: bigint, country: string, now = NOW) => authorize({ card: ariCard, amount: minor, currency: 'USD', country, now });

  beforeAll(async () => {
    await provisionAuthorisationSystemAccounts(db); // T-0413: a converted authorisation only reads these
    const s = await app.services.kyc.start(ari, 'T2', 'kyc-ari', NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-ari', sessionId: s.sessionId, status: 'approved' }), now: NOW });
    ariCard = (await db.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1`, [ari])).rows[0]!.processor_card_id;
    ariIls = await app.services.accounts.memberAccount(ari, 'wallet', 'ILS');
    ariUsd = await app.services.accounts.memberAccount(ari, 'wallet', 'USD');
    await credit(ariIls, 'ILS', 50_000n, 'load:ari:ils');
    await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, NOW);
  });

  it('a $50 purchase in Israel holds from the shekel purse at the club rate plus the plan markup; a replay holds nothing more', async () => {
    const r = await usdPay(5_000n, 'IL');
    expect(r.body).toEqual({ result: 'APPROVED', holdAmount: { minor: '5000', currency: 'USD' } });
    // $50 × 3.70 = ₪185.00; the default 75 bps is ₪1.39; the shekel purse pays ₪186.39 and the dollar pending purse holds $50.
    expect(await holdPostings(r.authId)).toEqual([
      { type: 'wallet', currency: 'ILS', amount_minor: '18639' },
      { type: 'fx_position', currency: 'USD', amount_minor: '5000' },
      { type: 'fee_income', currency: 'ILS', amount_minor: '-139' },
      { type: 'pending', currency: 'USD', amount_minor: '-5000' },
      { type: 'fx_position', currency: 'ILS', amount_minor: '-18500' },
    ]);
    const meta = (await db.query<{ metadata: Record<string, unknown> }>(`select metadata from ledger.journal where idempotency_key = $1`, [holdKey(r.authId)])).rows[0]!.metadata;
    expect(meta).toMatchObject({ fx_rate_version: expect.any(Number), fx_markup_bps: 75, rate: '3.700000', paidFrom: { minor: '18639', currency: 'ILS' }, markup: { minor: '139', currency: 'ILS' } });
    expect(-(await app.services.ledger.balance(ariIls, 'ILS'))).toBe(50_000n - 18_639n);

    const signed = sim.authorize(ariCard, { amount: { minor: 5_000n, currency: 'USD' }, merchant: MERCHANT, channel: 'pos' });
    const replay = await dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: signed.headers, rawBody: JSON.stringify({ ...(JSON.parse(signed.rawBody) as Record<string, unknown>), authId: r.authId }), now: NOW });
    expect(replay.body).toEqual({ result: 'APPROVED', holdAmount: { minor: '5000', currency: 'USD' } });
    expect(-(await app.services.ledger.balance(ariIls, 'ILS'))).toBe(50_000n - 18_639n);
  });

  it('a converted purchase with a system account missing declines TIMEOUT, holds nothing and creates no account (T-0413)', async () => {
    const accountCount = async () => Number((await db.query<{ n: string }>('select count(*) as n from ledger.account')).rows[0]!.n);
    const before = await accountCount();
    const heldBefore = -(await app.services.ledger.balance(ariIls, 'ILS'));
    const missing = vi.spyOn(app.services.accounts, 'findSystemAccount').mockRejectedValue(new DomainError('NOT_FOUND', 'No fx_position account in USD'));
    try {
      const r = await usdPay(5_000n, 'IL');
      expect(r.body).toEqual({ result: 'DECLINED', reason: 'TIMEOUT' });
      expect(await holdPostings(r.authId)).toEqual([]);
    } finally {
      missing.mockRestore();
    }
    expect(await accountCount()).toBe(before);
    expect(-(await app.services.ledger.balance(ariIls, 'ILS'))).toBe(heldBefore);
  });

  it('in Israel with the shekel purse short, the dollar purse pays unconverted', async () => {
    await credit(ariUsd, 'USD', 100_000n, 'load:ari:usd');
    const r = await usdPay(100_000n, 'IL'); // $1,000 is ₪3,700 and more: the shekel purse cannot cover it
    expect(r.body).toMatchObject({ result: 'APPROVED' });
    expect(await holdPostings(r.authId)).toEqual([
      { type: 'wallet', currency: 'USD', amount_minor: '100000' },
      { type: 'pending', currency: 'USD', amount_minor: '-100000' },
    ]);
  });

  it('elsewhere the dollar purse pays first, and a short dollar purse is covered by the shekel purse converted', async () => {
    const empty = await usdPay(1_000n, 'US'); // the dollar purse is empty after the $1,000 hold
    expect(empty.body).toMatchObject({ result: 'APPROVED' });
    // $10 × 3.70 = ₪37.00, plus ₪0.28 at 75 bps.
    expect((await holdPostings(empty.authId))[0]).toEqual({ type: 'wallet', currency: 'ILS', amount_minor: '3728' });
    await credit(ariUsd, 'USD', 5_000n, 'load:ari:usd-2');
    const direct = await usdPay(1_000n, 'US');
    expect(await holdPostings(direct.authId)).toEqual([
      { type: 'wallet', currency: 'USD', amount_minor: '1000' },
      { type: 'pending', currency: 'USD', amount_minor: '-1000' },
    ]);
  });

  it('with no valid club rate only the same-currency purse is tried', async () => {
    const later = new Date(NOW.getTime() + 20 * 60_000); // the port rate is good for 15 minutes
    expect((await usdPay(1_000n, 'IL', later)).body).toMatchObject({ result: 'APPROVED' }); // dollars pay, unconverted
    expect((await usdPay(100_000n, 'US', later)).body).toEqual({ result: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' }); // the shekel purse would need a rate
  });
});

// T-0413: the authorisation path only reads accounts, because its database role may not insert into ledger.account.
describe('the authorisation never creates an account (T-0413)', () => {
  const accountCount = async () => Number((await db.query<{ n: string }>('select count(*) as n from ledger.account')).rows[0]!.n);
  const lena = uuidv7(new Date(NOW.getTime() + 7));
  let lenaCard = '';

  beforeAll(async () => {
    const s = await app.services.kyc.start(lena, 'T2', 'kyc-lena', NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-lena', sessionId: s.sessionId, status: 'approved', tier: 'T2' }), now: NOW });
    lenaCard = (await db.query<{ processor_card_id: string }>('select processor_card_id from cards.card where party_id = $1', [lena])).rows[0]!.processor_card_id;
    const wallet = await app.services.accounts.memberAccount(lena, 'wallet', 'ILS');
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: 'load:lena', kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 50_000n }, { accountId: wallet, currency: 'ILS', amountMinor: -50_000n }] });
  }, 60_000);

  it('issuing the card provisioned the pending account in both currencies, once', async () => {
    const rows = (await db.query<{ currency: string }>(`select currency::text from ledger.account where owner_party_id = $1 and type = 'pending' order by currency`, [lena])).rows;
    expect(rows.map((r) => r.currency)).toEqual(['ILS', 'USD']);
  });

  it('an approved authorisation inserts no account', async () => {
    const before = await accountCount();
    const r = await authorize({ card: lenaCard, amount: 2_000n });
    expect(r.body).toMatchObject({ result: 'APPROVED' });
    expect(await accountCount()).toBe(before);
  });

  it('a card with no pending account at all (issued before this change) declines TIMEOUT and creates nothing', async () => {
    const olga = uuidv7(new Date(NOW.getTime() + 9));
    const s = await app.services.kyc.start(olga, 'T2', 'kyc-olga', NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-olga', sessionId: s.sessionId, status: 'approved', tier: 'T2' }), now: NOW });
    const olgaCard = (await db.query<{ processor_card_id: string }>('select processor_card_id from cards.card where party_id = $1', [olga])).rows[0]!.processor_card_id;
    const wallet = await app.services.accounts.memberAccount(olga, 'wallet', 'ILS');
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: 'load:olga', kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 50_000n }, { accountId: wallet, currency: 'ILS', amountMinor: -50_000n }] });
    await db.query(`delete from ledger.account where owner_party_id = $1 and type = 'pending'`, [olga]);
    const before = await accountCount();
    const r = await authorize({ card: olgaCard, amount: 2_000n });
    expect(r.body).toEqual({ result: 'DECLINED', reason: 'TIMEOUT' });
    expect(await accountCount()).toBe(before);
  });
});

// T-0774: the daily and monthly held-sum reads become one read-only query. The decision and its reason
// code must not move, so the table below was written against the sequential code first and passes on it.
describe('spend limits: characterization table (T-0774, TST-CRD-003)', () => {
  const N = new Date('2026-11-15T12:00:00Z'); // "now": mid-month, mid-day
  const DAY = new Date('2026-11-15T00:00:00Z'); // start of the UTC day
  const MONTH = new Date('2026-11-01T00:00:00Z'); // start of the UTC month
  const ago = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
  const H = 3_600_000;
  type Seed = [minor: bigint, at: Date];
  interface Row { name: string; funds?: bigint; daily?: [bigint, 'ILS' | 'USD']; monthly?: [bigint, 'ILS' | 'USD']; seeds: Seed[]; amount: bigint; now?: Date; expect: string }

  async function fresh(funds = 10_000_000n) {
    const party = uuidv7(NOW);
    const s = await app.services.kyc.start(party, 'T2', `kyc:${party}`, NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt:${party}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
    const c = (await db.query<{ id: string; processor_card_id: string }>(`select id, processor_card_id from cards.card where party_id = $1`, [party])).rows[0]!;
    const w = await app.services.accounts.memberAccount(party, 'wallet', 'ILS');
    const p = await app.services.accounts.memberAccount(party, 'pending', 'ILS');
    // Huge funds come from a purse of their own: the shared partner account's balance cache is a bigint and would overflow.
    const partner = funds > 1_000_000_000_000n ? await app.services.accounts.memberAccount(uuidv7(NOW), 'wallet', 'ILS') : await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: `load:${party}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: funds }, { accountId: w, currency: 'ILS', amountMinor: -funds }] });
    return { party, card: c.id, processor: c.processor_card_id, wallet: w, pending: p };
  }
  const hold = (f: { card: string; wallet: string; pending: string }, minor: bigint, at: Date, tag: string) =>
    app.services.ledger.post({ idempotencyKey: `seed:${f.card}:${tag}`, kind: 'auth_hold', effectiveAt: at, metadata: { cardId: f.card }, postings: [{ accountId: f.wallet, currency: 'ILS', amountMinor: minor }, { accountId: f.pending, currency: 'ILS', amountMinor: -minor }] });
  const limits = (f: { card: string }, r: Pick<Row, 'daily' | 'monthly'>) =>
    db.query(`update cards.card set controls = $2 where id = $1`, [f.card, JSON.stringify(controlsToWire({ ...DEFAULT_VIRTUAL_CONTROLS, ...(r.daily ? { dailyLimit: money(r.daily[0], r.daily[1]) } : {}), ...(r.monthly ? { monthlyLimit: money(r.monthly[0], r.monthly[1]) } : {}) }))]);
  const ask = (f: { processor: string }, amount: bigint, now: Date) =>
    app.services.jit.decide({ authId: uuidv7(now), cardId: f.processor, amount: money(amount, 'ILS'), merchant: MERCHANT, channel: 'pos', receivedAt: now.toISOString() }, now);
  const reasonOf = (d: { approve: boolean; reason?: string }): string => (d.approve ? 'APPROVED' : (d.reason ?? ''));

  const LIM = 'LIMIT_EXCEEDED';
  const BIG_SEEDS: Seed[] = [[4_000_000_000_000_000_001n, ago(N, -H)], [4_000_000_000_000_000_003n, ago(N, -2 * H)]];
  const BIG_HELD = 8_000_000_000_000_000_004n;
  const BIG_FUNDS = 9_000_000_000_000_000_000n;
  const rows: Row[] = [
    // Held sums above 2^53 (and near 2^63): a BigInt(Number(x)) slip rounds these and flips the verdict.
    { name: 'held sums above 2^53: daily exactly at the limit is approved', funds: BIG_FUNDS, daily: [BIG_HELD + 100n, 'ILS'], seeds: BIG_SEEDS, amount: 100n, expect: 'APPROVED' },
    { name: 'held sums above 2^53: daily one under the limit is declined', funds: BIG_FUNDS, daily: [BIG_HELD + 99n, 'ILS'], seeds: BIG_SEEDS, amount: 100n, expect: LIM },
    { name: 'held sums above 2^53: monthly exactly at the limit is approved', funds: BIG_FUNDS, monthly: [BIG_HELD + 100n, 'ILS'], seeds: BIG_SEEDS, amount: 100n, expect: 'APPROVED' },
    { name: 'held sums above 2^53: monthly one under the limit is declined', funds: BIG_FUNDS, monthly: [BIG_HELD + 99n, 'ILS'], seeds: BIG_SEEDS, amount: 100n, expect: LIM },
    { name: 'held sums above 2^53: a limit of 2^63-1 approves', funds: BIG_FUNDS, daily: [9_223_372_036_854_775_807n, 'ILS'], monthly: [9_223_372_036_854_775_807n, 'ILS'], seeds: BIG_SEEDS, amount: 100n, expect: 'APPROVED' },
    { name: 'held sums above 2^53: yesterday\'s big holds are monthly only', funds: BIG_FUNDS, daily: [1_000n, 'ILS'], monthly: [BIG_HELD + 99n, 'ILS'], seeds: BIG_SEEDS.map(([m, at]) => [m, ago(at, -24 * H)] as Seed), amount: 100n, expect: LIM },
    { name: 'no limits set: approved whatever is held', seeds: [[5_000n, N]], amount: 1_000n, expect: 'APPROVED' },
    { name: 'daily exactly at the limit is approved', daily: [2_000n, 'ILS'], seeds: [[1_800n, ago(N, -H)]], amount: 200n, expect: 'APPROVED' },
    { name: 'daily one minor over is declined', daily: [2_000n, 'ILS'], seeds: [[1_800n, ago(N, -H)]], amount: 201n, expect: LIM },
    { name: 'monthly exactly at the limit is approved', monthly: [2_000n, 'ILS'], seeds: [[1_800n, ago(MONTH, 5 * H)]], amount: 200n, expect: 'APPROVED' },
    { name: 'monthly one minor over is declined', monthly: [2_000n, 'ILS'], seeds: [[1_800n, ago(MONTH, 5 * H)]], amount: 201n, expect: LIM },
    { name: 'both set, daily under and monthly over: declined', daily: [1_000n, 'ILS'], monthly: [3_000n, 'ILS'], seeds: [[2_900n, ago(N, -24 * H)]], amount: 500n, expect: LIM },
    { name: 'both set, daily over and monthly under: declined', daily: [1_000n, 'ILS'], monthly: [10_000n, 'ILS'], seeds: [[800n, N]], amount: 300n, expect: LIM },
    { name: 'both set and both over: declined', daily: [1_000n, 'ILS'], monthly: [1_500n, 'ILS'], seeds: [[2_000n, ago(N, -H)]], amount: 100n, expect: LIM },
    { name: 'both set and neither over: approved', daily: [1_000n, 'ILS'], monthly: [10_000n, 'ILS'], seeds: [[500n, ago(N, -H)], [2_000n, ago(N, -48 * H)]], amount: 400n, expect: 'APPROVED' },
    { name: 'a hold from yesterday counts to the monthly sum', monthly: [2_000n, 'ILS'], seeds: [[1_900n, ago(N, -24 * H)]], amount: 101n, expect: LIM },
    { name: 'a hold from yesterday does not count to the daily sum', daily: [1_900n, 'ILS'], seeds: [[1_900n, ago(N, -24 * H)]], amount: 1_900n, expect: 'APPROVED' },
    { name: 'a hold exactly at the day start is in the daily window (at the limit approves)', daily: [1_000n, 'ILS'], seeds: [[900n, DAY]], amount: 100n, expect: 'APPROVED' },
    { name: 'a hold exactly at the day start is in the daily window (one over declines)', daily: [1_000n, 'ILS'], seeds: [[900n, DAY]], amount: 101n, expect: LIM },
    { name: 'a hold 1 ms before the day start is not in the daily window', daily: [1_000n, 'ILS'], seeds: [[900n, ago(DAY, -1)]], amount: 1_000n, expect: 'APPROVED' },
    { name: 'a hold exactly at the month start is in the monthly window', monthly: [1_000n, 'ILS'], seeds: [[900n, MONTH]], amount: 101n, expect: LIM },
    { name: 'a hold 1 ms before the month start is not in the monthly window', monthly: [1_000n, 'ILS'], seeds: [[900n, ago(MONTH, -1)]], amount: 1_000n, expect: 'APPROVED' },
    { name: 'a hold from last month (expired out of both windows) counts to neither', daily: [1_000n, 'ILS'], monthly: [1_000n, 'ILS'], seeds: [[999_999n, new Date('2026-10-20T10:00:00Z')]], amount: 1_000n, expect: 'APPROVED' },
    { name: 'on the 1st at 00:00 UTC a hold is in both windows (daily trips)', now: new Date('2026-11-01T09:00:00Z'), daily: [1_000n, 'ILS'], monthly: [100_000n, 'ILS'], seeds: [[900n, MONTH]], amount: 101n, expect: LIM },
    { name: 'on the 1st at 00:00 UTC a hold is in both windows (monthly trips)', now: new Date('2026-11-01T09:00:00Z'), daily: [100_000n, 'ILS'], monthly: [1_000n, 'ILS'], seeds: [[900n, MONTH]], amount: 101n, expect: LIM },
    { name: 'on the 1st the day before month start (last month) counts to neither', now: new Date('2026-11-01T09:00:00Z'), daily: [1_000n, 'ILS'], monthly: [1_000n, 'ILS'], seeds: [[900n, ago(MONTH, -1)]], amount: 1_000n, expect: 'APPROVED' },
    { name: 'a hold dated after now still counts (no upper bound)', daily: [1_000n, 'ILS'], seeds: [[900n, ago(N, H)]], amount: 101n, expect: LIM },
    { name: 'limits in another currency than the authorisation are ignored', daily: [1n, 'USD'], monthly: [1n, 'USD'], seeds: [[5_000n, N]], amount: 100n, expect: 'APPROVED' },
    { name: 'a daily limit in the other currency is ignored while a same-currency monthly one applies', daily: [1n, 'USD'], monthly: [1_000n, 'ILS'], seeds: [[900n, N]], amount: 101n, expect: LIM },
  ];

  it.each(rows)('$name', async (r) => {
    const f = await fresh(r.funds);
    await limits(f, r);
    for (const [i, [minor, at]] of r.seeds.entries()) await hold(f, minor, at, String(i));
    const out = await ask(f, r.amount, r.now ?? N);
    expect(reasonOf(out.decision)).toBe(r.expect);
  });

  it('the limits are checked before the purse: over the limit and over the balance is LIMIT_EXCEEDED, within the limit it is INSUFFICIENT_FUNDS', async () => {
    const f = await fresh(10_000n);
    await limits(f, { daily: [1_000n, 'ILS'] });
    expect(reasonOf((await ask(f, 50_000n, N)).decision)).toBe(LIM);
    await limits(f, {});
    expect(reasonOf((await ask(f, 5_000_000n, N)).decision)).toBe('INSUFFICIENT_FUNDS');
  });

  it('the velocity rule still declines on ten holds in the last minute with limits set and not reached', async () => {
    const f = await fresh();
    await limits(f, { daily: [1_000_000n, 'ILS'], monthly: [1_000_000n, 'ILS'] });
    for (let i = 0; i < VELOCITY_LIMIT_PER_MINUTE; i++) await hold(f, 1n, ago(N, -10_000), `v${i}`);
    expect(reasonOf((await ask(f, 1n, N)).decision)).toBe(LIM);
  });

  it("another card's holds, this card's holds on another purse and other journal kinds on this purse are not in the sum", async () => {
    const f = await fresh();
    const other = await fresh();
    const usdPending = await app.services.accounts.memberAccount(f.party, 'pending', 'USD');
    const usdWallet = await app.services.accounts.memberAccount(f.party, 'wallet', 'USD');
    await limits(f, { daily: [1_000n, 'ILS'], monthly: [1_000n, 'ILS'] });
    await hold(other, 50_000n, N, 'x'); // the other card's own purse
    await app.services.ledger.post({ idempotencyKey: `seed:${f.card}:usd`, kind: 'auth_hold', effectiveAt: N, metadata: { cardId: f.card }, postings: [{ accountId: usdWallet, currency: 'USD', amountMinor: 50_000n }, { accountId: usdPending, currency: 'USD', amountMinor: -50_000n }] });
    await app.services.ledger.post({ idempotencyKey: `seed:${f.card}:settle`, kind: 'card_settle', effectiveAt: N, metadata: { cardId: f.card }, postings: [{ accountId: f.wallet, currency: 'ILS', amountMinor: 50_000n }, { accountId: f.pending, currency: 'ILS', amountMinor: -50_000n }] });
    expect(reasonOf((await ask(f, 1_000n, N)).decision)).toBe('APPROVED');
  });
});

describe('spend limits: reads per authorisation (T-0774)', () => {
  const N = new Date('2026-11-15T12:00:00Z');
  const heldSums = (log: string[]): string[] => log.filter((t) => /sum\(-p\.amount_minor\)/.test(t));
  async function withSpy(daily: bigint | undefined, monthly: bigint | undefined) {
    const party = uuidv7(NOW);
    const s = await app.services.kyc.start(party, 'T2', `kyc:${party}`, NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt:${party}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
    const c = (await db.query<{ id: string; processor_card_id: string }>(`select id, processor_card_id from cards.card where party_id = $1`, [party])).rows[0]!;
    const w = await app.services.accounts.memberAccount(party, 'wallet', 'ILS');
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: `load:${party}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 100_000n }, { accountId: w, currency: 'ILS', amountMinor: -100_000n }] });
    await db.query(`update cards.card set controls = $2 where id = $1`, [c.id, JSON.stringify(controlsToWire({ ...DEFAULT_VIRTUAL_CONTROLS, ...(daily ? { dailyLimit: money(daily, 'ILS') } : {}), ...(monthly ? { monthlyLimit: money(monthly, 'ILS') } : {}) }))]);
    const log: string[] = [];
    const spy = { query: ((text: string, params?: readonly unknown[]) => { log.push(text); return db.query(text, params); }) as Database['query'], transaction: db.transaction.bind(db) } as Database;
    const jit = new JitService({ db: spy, port: sim, ledger: app.services.ledger, accounts: app.services.accounts, memberships: app.services.memberships, entitlements: app.services.entitlements, plans: app.services.plans, flags: app.services.flags, intents: app.services.intents });
    const decide = (amount: bigint) => jit.decide({ authId: uuidv7(N), cardId: c.processor_card_id, amount: money(amount, 'ILS'), merchant: MERCHANT, channel: 'pos', receivedAt: N.toISOString() }, N);
    return { log, decide };
  }

  it('no limit set: no held-sum query at all', async () => {
    const t = await withSpy(undefined, undefined);
    expect((await t.decide(100n)).decision).toMatchObject({ approve: true });
    expect(heldSums(t.log)).toHaveLength(0);
  });
  it('only a daily limit: one held-sum query', async () => {
    const t = await withSpy(10_000n, undefined);
    expect((await t.decide(100n)).decision).toMatchObject({ approve: true });
    expect(heldSums(t.log)).toHaveLength(1);
  });
  it('only a monthly limit: one held-sum query', async () => {
    const t = await withSpy(undefined, 10_000n);
    expect((await t.decide(100n)).decision).toMatchObject({ approve: true });
    expect(heldSums(t.log)).toHaveLength(1);
  });
  it('both limits: one held-sum query, whether the answer is approve or decline, and it only reads', async () => {
    for (const amount of [100n, 50_000n]) {
      const t = await withSpy(10_000n, 20_000n);
      const holds = (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal`)).rows[0]!.n;
      const out = await t.decide(amount);
      expect(out.decision.approve).toBe(amount === 100n);
      const sums = heldSums(t.log);
      expect(sums).toHaveLength(1);
      expect(sums[0]).not.toMatch(/\b(insert|update|delete|for\s+(update|share))\b/i);
      // A decline writes nothing; an approval writes exactly its own hold.
      const after = (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal`)).rows[0]!.n;
      expect(after - holds).toBe(out.decision.approve ? 1 : 0);
    }
  });
});

describe('spend limits: old and new agree over random ledger states (T-0774)', () => {
  const N = new Date('2026-11-15T12:00:00Z');
  const startDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const startMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  // The sequential code this card replaces, kept here verbatim as the reference: two reads, daily first.
  const heldSince = async (cardId: string, pendingAccount: string, from: Date): Promise<bigint> => {
    const r = await db.query<{ held: string }>(
      `select coalesce(sum(-p.amount_minor), 0)::text as held from ledger.journal j join ledger.posting p on p.journal_id = j.id
        where j.kind = 'auth_hold' and j.metadata->>'cardId' = $1 and p.account_id = $2 and j.effective_at >= $3`,
      [cardId, pendingAccount, from],
    );
    return BigInt(r.rows[0]?.held ?? '0');
  };
  const legacy = async (i: { cardId: string; pendingAccount: string; now: Date; amount: Money; dailyLimit?: Money; monthlyLimit?: Money }): Promise<SpendLimitHit | undefined> => {
    const currency = i.amount.currency;
    if (i.dailyLimit && i.dailyLimit.currency === currency) {
      if ((await heldSince(i.cardId, i.pendingAccount, startDay(i.now))) + i.amount.minor > i.dailyLimit.minor) return 'daily';
    }
    if (i.monthlyLimit && i.monthlyLimit.currency === currency) {
      if ((await heldSince(i.cardId, i.pendingAccount, startMonth(i.now))) + i.amount.minor > i.monthlyLimit.minor) return 'monthly';
    }
    return undefined;
  };

  // mulberry32: a seeded generator, so a failure names a seed that replays.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('the same verdict, the same first limit, for 150 seeded ledger states and limit settings', async () => {
    const party = uuidv7(NOW);
    const wallet = await app.services.accounts.memberAccount(party, 'wallet', 'ILS');
    const pending = await app.services.accounts.memberAccount(party, 'pending', 'ILS');
    const otherPending = await app.services.accounts.memberAccount(party, 'pending', 'USD');
    const otherWallet = await app.services.accounts.memberAccount(party, 'wallet', 'USD');
    // Instants that sit on and around both window edges, plus ordinary ones.
    const instants = [startMonth(N), startDay(N), N].flatMap((e) => [-1, 0, 1].map((d) => new Date(e.getTime() + d))).concat([new Date('2026-10-31T23:59:59Z'), new Date('2026-11-14T12:00:00Z'), new Date('2026-11-15T11:59:00Z'), new Date('2026-11-20T00:00:00Z'), new Date('2026-09-01T00:00:00Z')]);
    const tally = { daily: 0, monthly: 0, none: 0 };
    let n = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const cardId = `card-diff-${seed}`;
      let day = 0n;
      let month = 0n;
      const holds = Math.floor(r() * 6);
      for (let k = 0; k < holds; k++) {
        const at = pick(instants);
        const minor = BigInt(1 + Math.floor(r() * 900));
        const kind = r() < 0.15 ? 'card_settle' : 'auth_hold'; // a non-hold journal on the same purse is never summed
        const onOtherCard = r() < 0.15;
        const onOtherPurse = r() < 0.15;
        const [w, p, cur] = onOtherPurse ? [otherWallet, otherPending, 'USD' as const] : [wallet, pending, 'ILS' as const];
        await app.services.ledger.post({ idempotencyKey: `diff:${seed}:${k}`, kind, effectiveAt: at, metadata: { cardId: onOtherCard ? `${cardId}-other` : cardId }, postings: [{ accountId: w, currency: cur, amountMinor: minor }, { accountId: p, currency: cur, amountMinor: -minor }] });
        if (kind === 'auth_hold' && !onOtherCard && !onOtherPurse) {
          if (at >= startMonth(N)) month += minor;
          if (at >= startDay(N)) day += minor;
        }
      }
      const amount = BigInt(1 + Math.floor(r() * 500));
      // Limits sit on the edge of what the state allows more often than not.
      const edge = (held: bigint) => pick([held + amount - 1n, held + amount, held + amount + 1n, held + amount + BigInt(Math.floor(r() * 1_000))]);
      const lim = (held: bigint): Money | undefined => {
        const x = r();
        if (x < 0.2) return undefined;
        return money(x < 0.3 ? 1n : edge(held), x < 0.4 ? 'USD' : 'ILS'); // some in another currency
      };
      const input = { cardId, pendingAccount: pending, now: N, amount: money(amount, 'ILS'), ...(() => { const d = lim(day); return d ? { dailyLimit: d } : {}; })(), ...(() => { const m = lim(month); return m ? { monthlyLimit: m } : {}; })() };
      const expected = await legacy(input);
      const got = await firstSpendLimitHit(db, input);
      expect({ seed, got }).toEqual({ seed, got: expected });
      tally[expected ?? 'none']++;
      n++;
    }
    // The generator reaches every outcome, so agreement is not agreement on "approve".
    expect(n).toBe(150);
    expect(tally.daily).toBeGreaterThan(10);
    expect(tally.monthly).toBeGreaterThan(10);
    expect(tally.none).toBeGreaterThan(10);
  }, 120_000);

  it('the same verdict with held sums above 2^53 and limits on the edge, up to 2^63-1', async () => {
    const edges = [0n, 1n, 2n, 1_023n, 1_025n];
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(1000 + seed);
      const party = uuidv7(NOW); // fresh purses: the balance cache is a bigint and each state holds ~8e18
      const w = await app.services.accounts.memberAccount(party, 'wallet', 'ILS');
      const p = await app.services.accounts.memberAccount(party, 'pending', 'ILS');
      const cardId = `card-diff-big-${seed}`;
      let day = 0n;
      let month = 0n;
      for (let k = 0; k < 2; k++) {
        const minor = 4_000_000_000_000_000_000n + BigInt(Math.floor(r() * 1_000_000)) * 2n + 1n;
        const at = k === 0 ? new Date(N.getTime() - 3_600_000) : new Date(N.getTime() - (r() < 0.5 ? 3_600_000 : 36 * 3_600_000));
        await app.services.ledger.post({ idempotencyKey: `diffbig:${seed}:${k}`, kind: 'auth_hold', effectiveAt: at, metadata: { cardId }, postings: [{ accountId: w, currency: 'ILS', amountMinor: minor }, { accountId: p, currency: 'ILS', amountMinor: -minor }] });
        if (at >= startMonth(N)) month += minor;
        if (at >= startDay(N)) day += minor;
      }
      const amount = BigInt(1 + Math.floor(r() * 500));
      const cap = 9_223_372_036_854_775_807n;
      const near = (held: bigint): bigint => { const v = held + amount - 3n + edges[Math.floor(r() * edges.length)]!; return v > cap ? cap : v; };
      const input = { cardId, pendingAccount: p, now: N, amount: money(amount, 'ILS'), dailyLimit: money(near(day), 'ILS'), monthlyLimit: money(near(month), 'ILS') };
      const expected = await legacy(input);
      expect({ seed, got: await firstSpendLimitHit(db, input) }).toEqual({ seed, got: expected });
      // The oracle too, in exact bigint arithmetic.
      const oracle = day + amount > input.dailyLimit.minor ? 'daily' : month + amount > input.monthlyLimit.minor ? 'monthly' : undefined;
      expect({ seed, expected }).toEqual({ seed, expected: oracle });
    }
  }, 120_000);

  it('an authorisation in dollars sees only the dollar purse and dollar limits', async () => {
    const party = uuidv7(NOW);
    const w = await app.services.accounts.memberAccount(party, 'wallet', 'USD');
    const p = await app.services.accounts.memberAccount(party, 'pending', 'USD');
    await app.services.ledger.post({ idempotencyKey: `diff:usd:${party}`, kind: 'auth_hold', effectiveAt: N, metadata: { cardId: 'card-diff-usd' }, postings: [{ accountId: w, currency: 'USD', amountMinor: 900n }, { accountId: p, currency: 'USD', amountMinor: -900n }] });
    for (const [daily, monthly] of [[money(1_000n, 'USD'), undefined], [money(1_000n, 'ILS'), undefined], [undefined, money(1_000n, 'USD')], [money(1_000n, 'USD'), money(5_000n, 'USD')]] as const) {
      const input = { cardId: 'card-diff-usd', pendingAccount: p, now: N, amount: money(101n, 'USD'), ...(daily ? { dailyLimit: daily } : {}), ...(monthly ? { monthlyLimit: monthly } : {}) };
      expect(await firstSpendLimitHit(db, input)).toBe(await legacy(input));
    }
  });
});

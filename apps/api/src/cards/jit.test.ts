// JIT authorisation (T-0403, REQ-CRD-003) end to end: the processor's signed request through
// POST /jit/card-authorizations, every decline reason, the hold journal on approval, replay, the
// plan's card entitlement, the velocity rule, and the fail-closed paths (a throw, a slow dependency).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { type CardIssuingPort, type CardIssuingSimulator, type JitAuthorizationRequest } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { CARD_SPEND_ENTITLEMENT, DECISION_BUDGET_MS, holdKey, JitService, VELOCITY_LIMIT_PER_MINUTE } from './jit.ts';
import { AGENT_PURCHASE_ACTION, agentGrantIdFor } from '../intents/service.ts';
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

async function authorize(input: { amount: bigint; currency?: 'USD' | 'ILS'; mcc?: string; country?: string; channel?: 'pos' | 'online' | 'atm'; tokenId?: string; agentic?: boolean; card?: string; signature?: string; now?: Date }) {
  const signed = sim.authorize(input.card ?? processorCardId, { amount: { minor: input.amount, currency: input.currency ?? 'ILS' }, merchant: { ...MERCHANT, mcc: input.mcc ?? MERCHANT.mcc, country: input.country ?? MERCHANT.country }, channel: input.channel ?? 'pos', ...(input.tokenId ? { tokenId: input.tokenId } : {}), ...(input.agentic ? { agentic: true } : {}) });
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

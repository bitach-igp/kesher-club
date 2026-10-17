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
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true }) });
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
    const broken = new JitService({ db: { query: async () => { throw new Error('connection reset'); }, transaction: async () => { throw new Error('connection reset'); } }, port: sim, ledger: app.services.ledger, accounts: app.services.accounts, memberships: app.services.memberships, entitlements: app.services.entitlements, plans: app.services.plans });
    const out = await broken.decide(request(), NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'TIMEOUT' });
    const signed = sim.authorize(processorCardId, { amount: { minor: 100n, currency: 'ILS' }, merchant: MERCHANT, channel: 'pos' });
    const r = await broken.handle(signed.headers, signed.rawBody, NOW);
    expect(r).toMatchObject({ status: 200, body: { result: 'DECLINED', reason: 'TIMEOUT' } });
  });

  it('a dependency slower than the budget is a TIMEOUT decline within the budget', async () => {
    const slowDb = { query: (text: string, params?: readonly unknown[]) => new Promise<never>(() => void [text, params]), transaction: async () => { throw new Error('unused'); } };
    const slow = new JitService({ db: slowDb, port: sim, ledger: app.services.ledger, accounts: app.services.accounts, memberships: app.services.memberships, entitlements: app.services.entitlements, plans: app.services.plans, budgetMs: 40 });
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

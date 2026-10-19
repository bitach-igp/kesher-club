// TST-CRD-003, release (T-0410): the hourly job releases every card hold nobody cleared within 7 days
// back to the wallet, once, and reports how far past its 7 days the oldest open hold is.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { createApp, type App } from '@kesher/api/app';
import { HOLD_RELEASE_MS } from '@kesher/api/cards/settlement';
import { createRegistry } from '@kesher/api/registry';
import { dispatch } from '@kesher/api/server';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { uuidv7 } from '@kesher/domain';
import type { CardIssuingPort, CardIssuingSimulator } from '@kesher/ports';
import { CardHoldReleaseJob, CYCLE_MS } from './release-holds.ts';

let db: TestDatabase;
let app: App;
let sim: CardIssuingSimulator;
const NOW = new Date('2026-11-01T09:00:00Z');
const party = uuidv7(NOW);
let card = '';
let wallet = '';

const balance = async () => -(await app.services.ledger.balance(wallet, 'ILS'));

beforeAll(async () => {
  db = await createTestDatabase();
  const { registry } = createRegistry('sim');
  sim = registry.resolve<CardIssuingPort>('card-issuing', 'IL') as CardIssuingSimulator;
  app = createApp({ db, registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true }) });
  const s = await app.services.kyc.start(party, 'T2', 'kyc-dana', NOW);
  await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-dana', sessionId: s.sessionId, status: 'approved' }), now: NOW });
  card = (await db.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1`, [party])).rows[0]!.processor_card_id;
  wallet = await app.services.accounts.memberAccount(party, 'wallet', 'ILS');
  const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
  await app.services.ledger.post({ idempotencyKey: 'load:dana', kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 10_000n }, { accountId: wallet, currency: 'ILS', amountMinor: -10_000n }] });
  const signed = sim.authorize(card, { amount: { minor: 2_500n, currency: 'ILS' }, merchant: { name: 'Rami Levy', mcc: '5411', country: 'IL' }, channel: 'pos' });
  expect((await dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: signed.headers, rawBody: signed.rawBody, now: NOW })).body).toMatchObject({ result: 'APPROVED' });
}, 60_000);
afterAll(async () => db.close());

describe('card-release-holds (TST-CRD-003, T-0410)', () => {
  it('leaves a hold alone for 7 days, then releases it to the wallet once', async () => {
    expect(await balance()).toBe(7_500n);
    const early = await new CardHoldReleaseJob(app.services.settlement, () => new Date(NOW.getTime() + HOLD_RELEASE_MS - 60_000)).run();
    expect(early).toMatchObject({ released: 0, errors: [], lagMs: 0, withinSla: true });
    expect(await balance()).toBe(7_500n);

    const due = new Date(NOW.getTime() + HOLD_RELEASE_MS + 60_000);
    expect(await new CardHoldReleaseJob(app.services.settlement, () => due).run()).toMatchObject({ released: 1, errors: [], lagMs: 0, withinSla: true });
    expect(await new CardHoldReleaseJob(app.services.settlement, () => due).run()).toMatchObject({ released: 0 });
    expect(await balance()).toBe(10_000n);
  });

  it('reports a hold it could not release as lag past the cycle', async () => {
    const stuck = new CardHoldReleaseJob({ releaseExpired: async () => ({ released: 0, errors: [{ authId: 'auth_x', error: 'boom' }], oldestOpenMs: HOLD_RELEASE_MS + 2 * CYCLE_MS }) }, () => NOW);
    expect(await stuck.run()).toMatchObject({ released: 0, errors: [{ authId: 'auth_x', error: 'boom' }], lagMs: 2 * CYCLE_MS, withinSla: false });
  });
});

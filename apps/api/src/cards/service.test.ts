// CardService (T-0402, REQ-CRD-001/002) over the card-issuing simulator and PGlite. TST-CRD-001: a T2
// approval issues a virtual card through the workflow keyed card-issue:{partyId}, once, within the SLA;
// TST-CRD-002: the record, the views and the details-token path never hold or return PAN, CVV or expiry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { CardIssuingError, type CardIssuingPort, type KycPort, type KycSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { CardService, controlsFromWire, controlsToWire, DEFAULT_VIRTUAL_CONTROLS, ISSUE_SLA_MS, issueWorkflowId } from './service.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-01T09:00:00Z');
const FORBIDDEN_KEYS = /pan|cvv|cvc|expiry|expiration|exp_month|exp_year|number/i;

const webhook = (body: unknown) => dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify(body), now: NOW });
async function approveT2(partyId: string, now = NOW): Promise<string> {
  const s = await app.services.kyc.start(partyId, 'T2', `kyc:${partyId}`, now);
  expect((await webhook({ eventId: `evt:${partyId}`, sessionId: s.sessionId, status: 'approved' })).status).toBe(200);
  return s.sessionId;
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true }) });
}, 60_000);
afterAll(async () => db.close());

describe('issue on T2 approval (TST-CRD-001)', () => {
  it('the KYC webhook issues one active virtual card, recorded under the workflow id, within the SLA', async () => {
    const party = uuidv7(NOW);
    await approveT2(party);
    const cards = await app.services.cards.forParty(party);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: 'virtual', status: 'active', controls: { blockedMccs: [], atm: false, online: true, agentPurchases: { mode: 'off' } }, lockedByFunder: [], tokens: [] });
    const row = await db.query<{ workflow_id: string; issued_at: Date; processor: string; status: string }>(`select workflow_id, issued_at, processor, status from cards.card where party_id = $1`, [party]);
    expect(row.rows[0]).toMatchObject({ workflow_id: issueWorkflowId(party), processor: 'simulator', status: 'active' });
    expect(new Date(row.rows[0]!.issued_at).getTime() - NOW.getTime()).toBeLessThanOrEqual(ISSUE_SLA_MS);
    // The webhook event is processed, so replay will not touch it again.
    const ev = await db.query<{ processed_at: Date | null; error: string | null }>(`select processed_at, error from ops.inbound_event where provider = 'kyc' and event_id = $1`, [`evt:${party}`]);
    expect(ev.rows[0]!.processed_at).not.toBeNull();
    expect(ev.rows[0]!.error).toBeNull();
  });

  it('is idempotent: a rerun of the workflow returns the same card and the processor sees one cardholder and one card', async () => {
    const party = uuidv7(NOW);
    await approveT2(party);
    const first = (await app.services.cards.forParty(party))[0]!;
    const again = await app.services.cards.issueVirtual(party, new Date(NOW.getTime() + 5_000));
    expect(again.id).toBe(first.id);
    expect(await app.services.cards.forParty(party)).toHaveLength(1);
    const e = await app.services.cards.eligibility(party);
    expect(e.existing?.id).toBe(first.id);
  });

  it('refuses without T2 (T1 or pending is not enough) and when the flag is off; neither leaves a record', async () => {
    const party = uuidv7(NOW);
    await expect(app.services.cards.issueVirtual(party, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const t1 = await app.services.kyc.start(party, 'T1', `kyc1:${party}`, NOW);
    await webhook({ eventId: `evt1:${party}`, sessionId: t1.sessionId, status: 'approved' });
    await expect(app.services.cards.issueVirtual(party, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const off = new CardService(db, host.registry.resolve<CardIssuingPort>('card-issuing', 'IL'), app.services.kyc, new StaticFlags());
    await expect(off.issueVirtual(party, NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect(await app.services.cards.forParty(party)).toEqual([]);
  });

  it('a T2 approval while the flag is off issues nothing and leaves the webhook processed', async () => {
    const offApp = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags() });
    const party = uuidv7(NOW);
    const s = await offApp.services.kyc.start(party, 'T2', `kyc:${party}`, NOW);
    const r = await dispatch(offApp, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt:${party}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
    expect(r.status).toBe(200);
    expect(await offApp.services.cards.forParty(party)).toEqual([]);
    expect((await offApp.services.kyc.status(party)).approvedTier).toBe('T2');
  });

  it('a processor outage surfaces as PROVIDER_UNAVAILABLE, records nothing, and the retry issues exactly once', async () => {
    let fail = true;
    const sim = host.registry.resolve<CardIssuingPort>('card-issuing', 'IL');
    const flaky: CardIssuingPort = {
      ...sim,
      createCardholder: (input, key) => {
        if (fail) throw new CardIssuingError('PROVIDER_UNAVAILABLE', 'processor down');
        return sim.createCardholder(input, key);
      },
      issueCard: (input, key) => sim.issueCard(input, key),
      showDetailsToken: (id) => sim.showDetailsToken(id),
    };
    const svc = new CardService(db, flaky, app.services.kyc, new StaticFlags(undefined, { 'card.virtual': true }));
    // Approve T2 through the service, not the webhook, so the app's own issue step stays out of the way.
    const party = uuidv7(NOW);
    const s = await app.services.kyc.start(party, 'T2', `kyc:${party}`, NOW);
    const decision = (host.registry.resolve<KycPort>('kyc', 'IL') as KycSimulator).decide(s.sessionId, 'approved');
    await app.services.kyc.applyDecision({ provider: 'kyc', eventId: `evt:${party}`, receivedAt: NOW.toISOString(), signatureOk: true, payload: { ...decision, eventId: `evt:${party}` } });
    await expect(svc.issueVirtual(party, NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await svc.forParty(party)).toEqual([]);
    fail = false;
    const card = await svc.issueVirtual(party, NOW);
    expect(card.status).toBe('active');
    expect((await svc.issueVirtual(party, NOW)).id).toBe(card.id);
    expect(await svc.forParty(party)).toHaveLength(1);
  });
});

describe('no card data anywhere (TST-CRD-002)', () => {
  it('the table has no column for PAN, CVV or expiry; the view and the record carry last4 only', async () => {
    const cols = await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'cards' and table_name = 'card'`);
    for (const c of cols.rows) expect(c.column_name, c.column_name).not.toMatch(FORBIDDEN_KEYS);
    const party = uuidv7(NOW);
    await approveT2(party);
    const [card] = await app.services.cards.forParty(party);
    expect(Object.keys(card!).sort()).toEqual(['controls', 'id', 'last4', 'lockedByFunder', 'status', 'tokens', 'type']);
    expect(card!.last4).toHaveLength(4);
    for (const k of Object.keys(card!)) expect(k).not.toMatch(FORBIDDEN_KEYS);
  });

  it('card details come only as the processor’s short-lived token, to the owner, and the token is not stored', async () => {
    const party = uuidv7(NOW);
    await approveT2(party);
    const [card] = await app.services.cards.forParty(party);
    const t = await app.services.cards.detailsToken(party, card!.id);
    expect(t.token).toMatch(/^sdt_/);
    expect(Date.parse(t.expiresAt) - NOW.getTime()).toBeLessThanOrEqual(60_000);
    await expect(app.services.cards.detailsToken(uuidv7(NOW), card!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const dump = JSON.stringify((await db.query(`select * from cards.card`)).rows);
    expect(dump).not.toContain(t.token);
    expect(dump).not.toContain('sdt_');
  });

  it('controls round-trip between the domain and the wire, money as strings', () => {
    const wire = controlsToWire({ ...DEFAULT_VIRTUAL_CONTROLS, dailyLimit: { minor: 50_000n, currency: 'USD' }, agentPurchases: { underMinor: 2_500n } });
    expect(wire).toEqual({ blockedMccs: [], atm: false, online: true, dailyLimit: { minor: '50000', currency: 'USD' }, agentPurchases: { mode: 'under_amount', underAmount: { minor: '2500', currency: 'USD' } } });
    expect(controlsFromWire(wire)).toEqual({ ...DEFAULT_VIRTUAL_CONTROLS, dailyLimit: { minor: 50_000n, currency: 'USD' }, agentPurchases: { underMinor: 2_500n } });
    expect(controlsFromWire(controlsToWire({ ...DEFAULT_VIRTUAL_CONTROLS, agentPurchases: 'with_approval' })).agentPurchases).toBe('with_approval');
  });
});

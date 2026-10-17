// Physical cards (T-0407, REQ-CRD-009) end to end. TST-CRD-009: the order needs a US or IL address,
// T2 and the flag; a shipped card carries tracking; activation with the last four digits under a fresh
// step-up makes it active and records the PIN as set, never the PIN. Also the card list and the
// details token under step-up (REQ-CRD-002).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { parseShipTo, PhysicalCardService } from './physical.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-01T09:00:00Z');
let member = '';
let access = '';
let stepUpToken = '';
let virtualCardId = '';

const IL = { name: 'Noa Example', line1: 'Herzl 12', city: 'Jerusalem', postalCode: '9100000', country: 'IL' };
const US = { name: 'Dana Example', line1: '1 Main St', city: 'Brooklyn', region: 'NY', postalCode: '11201', country: 'US' };
const call = (method: string, url: string, body?: unknown, h: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization: `Bearer ${access}`, ...h }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const order = (shipTo: unknown, key = 'physical-order-1') => call('POST', '/v1/cards/physical', { shipTo }, { 'idempotency-key': key });
type CardBody = { id: string; type: string; status: string; last4: string; shipping?: { trackingUrl?: string; activatedAt?: string; pinSet: boolean } };

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true, 'card.physical': true }) });
  const s = app.services;
  const started = await s.otp.start({ phone: '+972501234567', locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
}, 60_000);
afterAll(async () => db.close());

describe('ordering (TST-CRD-009)', () => {
  it('refuses before T2, then issues an inactive physical card with tracking; the same key returns it and a second card is refused', async () => {
    await expect(order(IL)).resolves.toMatchObject({ status: 403 });
    const kyc = await app.services.kyc.start(member, 'T2', 'kyc-noa', NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-kyc', sessionId: kyc.sessionId, status: 'approved' }), now: NOW });
    virtualCardId = (await app.services.cards.forParty(member))[0]!.id;

    const r = await order(IL);
    expect(r.status).toBe(201);
    const card = r.body as CardBody;
    expect(card).toMatchObject({ type: 'physical', status: 'inactive', shipping: { pinSet: false } });
    expect(card.shipping?.trackingUrl).toMatch(/^https:\/\/track\.sim\.kesher\.example\//);
    expect(card.shipping?.activatedAt).toBeUndefined();
    expect(Object.keys(card).sort()).toEqual(['controls', 'id', 'last4', 'lockedByFunder', 'shipping', 'status', 'tokens', 'type']);
    expect((await order(IL)).body).toMatchObject({ id: card.id });
    expect((await order(US, 'physical-order-2')).status).toBe(409);
    // The address is forwarded, never stored.
    const dump = JSON.stringify((await db.query(`select * from cards.card`)).rows);
    expect(dump).not.toContain('Herzl');
    expect(dump).not.toContain('9100000');
    // One cardholder at the processor for both cards.
    expect(new Set((await db.query<{ cardholder_id: string }>(`select cardholder_id from cards.card where party_id = $1`, [member])).rows.map((x) => x.cardholder_id)).size).toBe(1);
  });

  it('validates the address: US or IL, required lines, a region for the US', () => {
    expect(() => parseShipTo({ ...IL, country: 'FR' })).toThrow(/country must be US or IL/);
    expect(() => parseShipTo({ ...IL, line1: '' })).toThrow(/line1 is required/);
    expect(() => parseShipTo({ ...US, region: undefined })).toThrow(/region is required/);
    expect(() => parseShipTo({ ...IL, postalCode: 'x'.repeat(17) })).toThrow(/postalCode must be text/);
    expect(parseShipTo({ ...IL, line2: ' Apt 4 ' })).toEqual({ ...IL, line2: 'Apt 4' });
    expect(parseShipTo(US)).toEqual(US);
  });

  it('the flag gates ordering', async () => {
    const off = new PhysicalCardService(db, host.registry.resolve('card-issuing', 'IL'), app.services.kyc, app.services.cards, new StaticFlags());
    await expect(off.order(uuidv7(NOW), parseShipTo(IL), 'physical-order-off', NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
  });
});

describe('activation and PIN (TST-CRD-009)', () => {
  it('needs a fresh step-up and the right last four digits; then the card is active and the PIN recorded as set, never the PIN', async () => {
    const card = ((await call('GET', '/v1/cards')).body as { items: CardBody[] }).items.find((c) => c.type === 'physical')!;
    const url = `/v1/cards/${card.id}/activate`;
    expect((await call('POST', url, { last4: card.last4 }, { 'idempotency-key': 'activate-1' })).status).toBe(401);
    expect((await call('POST', url, { last4: card.last4 }, { 'x-step-up': stepUpToken })).status).toBe(422);
    expect((await call('POST', url, { last4: '12' }, { 'idempotency-key': 'activate-2', 'x-step-up': stepUpToken })).status).toBe(422);
    const wrong = await call('POST', url, { last4: card.last4 === '0001' ? '0002' : '0001' }, { 'idempotency-key': 'activate-3', 'x-step-up': stepUpToken });
    expect(wrong.status).toBe(422);
    expect((await call('GET', `/v1/cards/${card.id}`)).body).toMatchObject({ status: 'inactive' });
    const right = await call('POST', url, { last4: card.last4 }, { 'idempotency-key': 'activate-4', 'x-step-up': stepUpToken });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ status: 'active', shipping: { pinSet: true, activatedAt: NOW.toISOString() } });
    const view = (await call('GET', `/v1/cards/${card.id}`)).body as CardBody;
    expect(view).toMatchObject({ status: 'active', shipping: { pinSet: true, activatedAt: NOW.toISOString() } });
    expect(JSON.stringify(view)).not.toMatch(/"pin"|pinCode|\d{13,19}/);
    // Activating again is a no-op; a virtual card cannot be activated.
    expect((await call('POST', url, { last4: '0000' }, { 'idempotency-key': 'activate-5', 'x-step-up': stepUpToken })).status).toBe(200);
    expect((await call('POST', `/v1/cards/${virtualCardId}/activate`, { last4: '0000' }, { 'idempotency-key': 'activate-6', 'x-step-up': stepUpToken })).status).toBe(422);
  });

  it('the list shows both cards with shipping on the physical one only; the details token needs a step-up', async () => {
    const items = ((await call('GET', '/v1/cards')).body as { items: CardBody[] }).items;
    // Both were issued at the frozen clock's instant, so the order between them is not meaningful here.
    expect(items.map((c) => [c.type, c.status, Boolean(c.shipping)]).sort()).toEqual([['physical', 'active', true], ['virtual', 'active', false]]);
    expect((await call('POST', `/v1/cards/${virtualCardId}/details-token`)).status).toBe(401);
    const t = await call('POST', `/v1/cards/${virtualCardId}/details-token`, undefined, { 'x-step-up': stepUpToken });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token: expect.stringMatching(/^sdt_/), expiresAt: expect.any(String) });
    expect((await call('POST', `/v1/cards/${uuidv7(NOW)}/details-token`, undefined, { 'x-step-up': stepUpToken })).status).toBe(404);
  });
});

describe('lost or stolen (REQ-CRD-004/009)', () => {
  it('freezing needs no step-up; unfreezing does; closing deletes the tokens and frees a replacement order', async () => {
    const physical = ((await call('GET', '/v1/cards')).body as { items: CardBody[] }).items.find((c) => c.type === 'physical')!;
    await db.query(`insert into cards.card_token (token_id, card_id, wallet, device_id, status) values ('dpan_p1', $1, 'apple', 'iphone-1', 'active')`, [physical.id]);
    const url = `/v1/cards/${physical.id}/status`;
    const frozen = await call('POST', url, { status: 'frozen' }, { 'idempotency-key': 'status-1' });
    expect(frozen.status).toBe(200);
    expect(frozen.body).toMatchObject({ status: 'frozen', shipping: { pinSet: true }, tokens: [{ deviceId: 'iphone-1', status: 'suspended' }] });
    expect((await call('POST', url, { status: 'active' }, { 'idempotency-key': 'status-2' })).status).toBe(401);
    expect((await call('POST', url, { status: 'active' }, { 'idempotency-key': 'status-2', 'x-step-up': stepUpToken })).body).toMatchObject({ status: 'active', tokens: [{ status: 'active' }] });
    expect((await call('POST', url, { status: 'lost' }, { 'idempotency-key': 'status-3', 'x-step-up': stepUpToken })).status).toBe(422);
    expect((await call('POST', url, { status: 'closed', reason: 'stolen' }, { 'idempotency-key': 'status-4' })).status).toBe(401);
    const closed = await call('POST', url, { status: 'closed', reason: 'stolen' }, { 'idempotency-key': 'status-4', 'x-step-up': stepUpToken });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', tokens: [{ deviceId: 'iphone-1', status: 'deleted' }] });
    expect((await db.query<{ last_event_id: string }>(`select last_event_id from cards.card_token where token_id = 'dpan_p1'`)).rows[0]).toEqual({ last_event_id: 'card.closed:stolen' });
    // Closed is final and idempotent; the member can now order the replacement.
    expect((await call('POST', url, { status: 'closed' }, { 'idempotency-key': 'status-5', 'x-step-up': stepUpToken })).body).toMatchObject({ status: 'closed' });
    expect((await call('POST', url, { status: 'active' }, { 'idempotency-key': 'status-6', 'x-step-up': stepUpToken })).status).toBe(422);
    const replacement = await order(US, 'physical-order-3');
    expect(replacement.status).toBe(201);
    expect((replacement.body as CardBody).id).not.toBe(physical.id);
    expect((await call('GET', '/v1/cards')).body).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: physical.id, status: 'closed' }), expect.objectContaining({ id: (replacement.body as CardBody).id, status: 'inactive' })]) });
  });
});

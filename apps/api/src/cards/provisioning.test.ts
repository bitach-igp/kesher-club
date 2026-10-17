// Push provisioning and token lifecycle (T-0405). TST-CRD-006: the provisioning payload only with a
// fresh step-up, owner only, flag on, and ALREADY_PROVISIONED for a device that already holds the
// token. TST-CRD-007: token.created / suspended / deleted webhooks update cards.card_token, deduped
// by event id; a forged event changes nothing; an event for an unknown card waits for replay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice, type CardIssuingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { detailsTokenProvisioning, parseTokenEvent, ProvisioningService } from './provisioning.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-01T09:00:00Z');
let member = '';
let access = '';
let stepUpToken = '';
let cardId = '';
let processorCardId = '';

const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${access}`, 'idempotency-key': 'provision-apple-1', ...extra });
const provision = (wallet: string, body: unknown, h: Record<string, string> = headers({ 'x-step-up': stepUpToken })) =>
  dispatch(app, { method: 'POST', url: `/v1/cards/${cardId}/provisioning/${wallet}`, headers: h, rawBody: JSON.stringify(body), now: NOW });
const tokenEvent = (body: unknown, signature = 'sim') => dispatch(app, { method: 'POST', url: '/v1/hooks/card-issuing', headers: { 'x-sim-signature': signature }, rawBody: JSON.stringify(body), now: NOW });
const tokens = async () => ((await dispatch(app, { method: 'GET', url: `/v1/cards/${cardId}`, headers: headers(), rawBody: '', now: NOW })).body as { tokens: { wallet: string; status: string; deviceId: string }[] }).tokens;

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true, 'card.pushProvisioning': true }) });
  // A real member with a passkey, so a step-up token exists (REQ-AUTH-006).
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
  // T2 approval issues the card.
  const kyc = await s.kyc.start(member, 'T2', `kyc:${member}`, NOW);
  await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-kyc', sessionId: kyc.sessionId, status: 'approved' }), now: NOW });
  const card = (await db.query<{ id: string; processor_card_id: string }>(`select id, processor_card_id from cards.card where party_id = $1`, [member])).rows[0]!;
  cardId = card.id;
  processorCardId = card.processor_card_id;
}, 60_000);
afterAll(async () => db.close());

describe('POST /cards/{id}/provisioning/{wallet} (TST-CRD-006)', () => {
  it('needs a fresh step-up, an idempotency key and the owner; the flag gates it', async () => {
    expect((await provision('apple', { deviceId: 'iphone-1', clientData: {} }, headers())).status).toBe(401);
    expect(((await provision('apple', { deviceId: 'iphone-1', clientData: {} }, headers())).body as { code: string }).code).toBe('STEP_UP_REQUIRED');
    expect((await provision('apple', { deviceId: 'iphone-1', clientData: {} }, { authorization: `Bearer ${access}`, 'x-step-up': stepUpToken })).status).toBe(422);
    const other = (await app.services.tokens.issue({ partyId: uuidv7(NOW), roles: ['member'], deviceId: 'd9' })).accessToken;
    const su = await dispatch(app, { method: 'POST', url: `/v1/cards/${cardId}/provisioning/apple`, headers: { authorization: `Bearer ${other}`, 'idempotency-key': 'provision-other-1', 'x-step-up': 'su_nope' }, rawBody: JSON.stringify({ deviceId: 'x', clientData: {} }), now: NOW });
    expect(su.status).toBe(401); // no step-up for that session
    const off = new ProvisioningService(db, app.services.cards, detailsTokenProvisioning(host.registry.resolve<CardIssuingPort>('card-issuing', 'IL')), new StaticFlags());
    await expect(off.start(member, cardId, 'apple', 'iphone-1', {})).rejects.toMatchObject({ code: 'FEATURE_OFF' });
  });

  it('hands the OS sheet an opaque payload with no card data, then refuses the same device once its token exists', async () => {
    const r = await provision('apple', { deviceId: 'iphone-1', clientData: { nonce: 'n1', certificates: 'c1' } });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['activationData', 'encryptedPassData', 'ephemeralPublicKey']);
    for (const v of Object.values(body)) expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(body)).not.toMatch(/\d{13,19}/);
    expect(Buffer.from(body['encryptedPassData']!, 'base64url').toString()).toMatch(/^apple:iphone-1:sdt_/);
    // The wallet created the token at the processor; the processor tells us.
    expect((await tokenEvent({ eventId: 'tok-evt-1', type: 'token.created', tokenId: 'dpan_1', cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1' })).status).toBe(200);
    expect(await tokens()).toEqual([{ wallet: 'apple', status: 'active', deviceId: 'iphone-1' }]);
    const again = await provision('apple', { deviceId: 'iphone-1', clientData: {} }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-apple-2' }));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', reason: 'ALREADY_PROVISIONED' });
    // Another wallet on the same device, or another device, is fine.
    expect((await provision('google', { deviceId: 'iphone-1', clientData: {} }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-google-1' }))).status).toBe(200);
    expect((await provision('apple', { deviceId: 'ipad-1', clientData: {} }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-apple-3' }))).status).toBe(200);
  });

  it('a frozen card is refused and an unknown wallet or body is 422', async () => {
    await app.services.cards.setStatus(member, cardId, 'frozen', 'freeze-p', NOW);
    expect((await provision('apple', { deviceId: 'ipad-2', clientData: {} }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-apple-4' }))).status).toBe(422);
    await app.services.cards.setStatus(member, cardId, 'active', 'unfreeze-p', NOW);
    expect((await provision('samsung', { deviceId: 'ipad-2', clientData: {} }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-x-1' }))).status).toBe(422);
    expect((await provision('apple', { deviceId: 'ipad-2' }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-x-2' }))).status).toBe(422);
  });
});

describe('token lifecycle webhooks (TST-CRD-007)', () => {
  it('suspended and deleted events update the token; a replayed event id applies once; a forged one is refused', async () => {
    expect((await tokenEvent({ eventId: 'tok-evt-2', type: 'token.suspended', tokenId: 'dpan_1', cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1' })).status).toBe(200);
    expect(await tokens()).toEqual([{ wallet: 'apple', status: 'suspended', deviceId: 'iphone-1' }]);
    const dup = await tokenEvent({ eventId: 'tok-evt-2', type: 'token.deleted', tokenId: 'dpan_1', cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1' });
    expect(dup.body).toEqual({ eventId: 'tok-evt-2', duplicate: true });
    expect(await tokens()).toEqual([{ wallet: 'apple', status: 'suspended', deviceId: 'iphone-1' }]);
    expect((await tokenEvent({ eventId: 'tok-evt-3', type: 'token.deleted', tokenId: 'dpan_1', cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1' }, 'forged')).status).toBe(401);
    expect(await tokens()).toEqual([{ wallet: 'apple', status: 'suspended', deviceId: 'iphone-1' }]);
    expect((await tokenEvent({ eventId: 'tok-evt-4', type: 'token.deleted', tokenId: 'dpan_1', cardId: processorCardId, wallet: 'apple', deviceId: 'iphone-1' })).status).toBe(200);
    expect(await tokens()).toEqual([{ wallet: 'apple', status: 'deleted', deviceId: 'iphone-1' }]);
    // A deleted token frees the device for a new provisioning.
    expect((await provision('apple', { deviceId: 'iphone-1', clientData: {} }, headers({ 'x-step-up': stepUpToken, 'idempotency-key': 'provision-apple-5' }))).status).toBe(200);
  });

  it('a freeze marks the live token and the processor’s own suspension is left alone on unfreeze', async () => {
    await tokenEvent({ eventId: 'tok-evt-5', type: 'token.created', tokenId: 'dpan_2', cardId: processorCardId, wallet: 'google', deviceId: 'pixel-1' });
    await tokenEvent({ eventId: 'tok-evt-6', type: 'token.created', tokenId: 'dpan_3', cardId: processorCardId, wallet: 'apple', deviceId: 'watch-1' });
    await tokenEvent({ eventId: 'tok-evt-7', type: 'token.suspended', tokenId: 'dpan_3', cardId: processorCardId, wallet: 'apple', deviceId: 'watch-1' });
    await app.services.cards.setStatus(member, cardId, 'frozen', 'freeze-q', NOW);
    expect((await tokens()).map((t) => [t.deviceId, t.status])).toEqual([['iphone-1', 'deleted'], ['pixel-1', 'suspended'], ['watch-1', 'suspended']]);
    await app.services.cards.setStatus(member, cardId, 'active', 'unfreeze-q', NOW);
    expect((await tokens()).map((t) => [t.deviceId, t.status])).toEqual([['iphone-1', 'deleted'], ['pixel-1', 'active'], ['watch-1', 'suspended']]);
  });

  it('an event for a card we do not know is stored unprocessed with the error, for the worker to retry', async () => {
    const r = await tokenEvent({ eventId: 'tok-evt-8', type: 'token.created', tokenId: 'dpan_9', cardId: 'card_999999', wallet: 'apple', deviceId: 'x' });
    expect(r.status).toBe(200);
    const row = (await db.query<{ processed_at: Date | null; error: string | null }>(`select processed_at, error from ops.inbound_event where provider = 'card-issuing' and event_id = 'tok-evt-8'`)).rows[0]!;
    expect(row.processed_at).toBeNull();
    expect(row.error).toMatch(/unknown card/);
    expect(() => parseTokenEvent({ eventId: 'x', type: 'token.moved', tokenId: 't', cardId: 'c', wallet: 'apple', deviceId: 'd' })).toThrow(/Unknown token event type/);
  });
});

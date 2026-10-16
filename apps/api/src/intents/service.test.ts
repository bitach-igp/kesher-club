// TST-AGT-006: T2 tools create a pending_intent, never move money. A human approves in-app with a
// passkey within 24 h or it expires. Given propose_p2p, no journal exists until approval.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { AuthSimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from '../auth/repository.ts';
import { OtpService } from '../auth/otp.ts';
import { PasskeyService } from '../auth/passkeys.ts';
import { StepUpService } from '../auth/step-up.ts';
import { TokenService, generateSigningKey } from '../auth/tokens.ts';
import { makeRequest, type Principal } from '../http.ts';
import { TransferService } from '../transfers/service.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { INTENT_TTL_MS, IntentService } from './service.ts';

let db: TestDatabase;
let clock: AdvanceableClock;
let intents: IntentService;
let stepUp: StepUpService;
let principal: Principal;
let device: SimPasskeyDevice;
const grantId = uuidv7();
const notified: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  clock = fixedClock('2026-11-01T09:00:00Z') as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  const otp = new OtpService(port, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'x', audience: 'x', clock });
  const passkeys = new PasskeyService(port, repo, tokens, clock, otp);
  stepUp = new StepUpService(port, repo, clock);
  intents = new IntentService(db, new TransferService(db), stepUp, async (_p, i) => void notified.push(i.summary));
  const { otpId } = await otp.start({ phone: '+972501234567', locale: 'en' });
  const v = await otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
  device = new SimPasskeyDevice();
  const s1 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd' });
  const s2 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd', response: await device.register(s1.options!) });
  principal = await tokens.verifyAccess(s2.tokens!.accessToken);
  await db.query(`insert into agent.client (client_id, name, metadata, fetched_at) values ('https://a.example/c', 'A', '{}', now())`);
  await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, 'https://a.example/c', $2, $3, 'active', now())`, [grantId, principal.partyId, ['p2p:propose']]);
}, 60_000);
afterAll(async () => db.close());

async function freshStepUp(): Promise<string> {
  const { options } = await stepUp.start(principal);
  return (await stepUp.complete(principal, await device.authenticate(options))).stepUpToken;
}
const approveReq = (stepUpToken?: string) => makeRequest({ method: 'POST', path: '/intents/x/approve', headers: { 'Idempotency-Key': `appr-${uuidv7()}`, ...(stepUpToken ? { 'X-Step-Up': stepUpToken } : {}) }, principal, now: clock.now() });

describe('IntentService (REQ-AGT-006)', () => {
  it('proposing creates a pending intent with a 24 h expiry and a push to the member; no journal, no transfer', async () => {
    const i = await intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '5000', currency: 'ILS' } } }, clock.now());
    expect(i.status).toBe('pending');
    expect(Date.parse(i.expiresAt) - clock.now().getTime()).toBe(INTENT_TTL_MS);
    expect(notified.at(-1)).toMatch(/Send ILS 5000/);
    expect((await db.query('select count(*)::int as n from ops.transfer')).rows[0]).toEqual({ n: 0 });
    expect((await intents.listPending(principal.partyId)).map((x) => x.id)).toContain(i.id);
  });

  it('approval needs a fresh passkey step-up; then the transfer is created under the member, keyed by the intent', async () => {
    const i = await intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '5000', currency: 'ILS' } } }, clock.now());
    await expect(intents.approve(approveReq(), i.id, 'k')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const r = await intents.approve(approveReq(await freshStepUp()), i.id, 'k');
    expect(r.intent.status).toBe('approved');
    expect(r.transfer).toMatchObject({ kind: 'p2p', state: 'created', idempotencyKey: `intent:${i.id}`, fromPartyId: principal.partyId });
    const again = await intents.approve(approveReq(await freshStepUp()), i.id, 'k2');
    expect(again.transfer!.id).toBe(r.transfer!.id);
  });

  it('a stranger cannot approve, a rejected intent stays rejected, and an expired one cannot be approved', async () => {
    const i = await intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { amount: { minor: '10000', currency: 'USD' } } }, clock.now());
    const stranger = { ...principal, partyId: uuidv7() };
    await expect(intents.reject(stranger, i.id, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await intents.reject(principal, i.id, clock.now())).status).toBe('rejected');
    await expect(intents.approve(approveReq(await freshStepUp()), i.id, 'k')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const old = await intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { amount: { minor: '100', currency: 'USD' } } }, clock.now());
    clock.advance(INTENT_TTL_MS + 1);
    expect(await intents.expire(clock.now())).toBeGreaterThanOrEqual(1);
    expect((await intents.get(old.id))!.status).toBe('expired');
  });

  it('a revoked grant blocks approval of its money intents; a recovery hold blocks P2P (REQ-AUTH-003)', async () => {
    const g2 = uuidv7();
    await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, 'https://a.example/c', $2, $3, 'active', now())`, [g2, principal.partyId, ['p2p:propose']]);
    const i = await intents.propose({ grantId: g2, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '1', currency: 'ILS' } } }, clock.now());
    await db.query(`update agent.grant set status = 'revoked' where id = $1`, [g2]);
    await expect(intents.approve(approveReq(await freshStepUp()), i.id, 'k')).rejects.toMatchObject({ code: 'AGENT_NOT_ALLOWED' });
    const held = await intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '1', currency: 'ILS' } } }, clock.now());
    const restricted = makeRequest({ method: 'POST', path: '/x', headers: { 'X-Step-Up': await freshStepUp() }, principal: { ...principal, restrictedUntil: new Date(clock.now().getTime() + 3_600_000).toISOString() }, now: clock.now() });
    await expect(intents.approve(restricted, held.id, 'k')).rejects.toMatchObject({ code: 'RECOVERY_HOLD' });
  });

  it('validates money and payload shape at proposal time', async () => {
    await expect(intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '-5', currency: 'ILS' } } }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { amount: { minor: '5', currency: 'ILS' } } }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { amount: 'twelve' } }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

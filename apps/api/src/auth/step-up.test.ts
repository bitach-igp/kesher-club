// TST-AUTH-006: money actions need a step-up (passkey/biometric) younger than 5 minutes. A 6-minute
// old session confirming a P2P send sees STEP_UP_REQUIRED first.
import { randomBytes } from 'node:crypto';
import { Secret } from '@kesher/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthSimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { makeRequest } from '../http.ts';
import { createPiiCipher } from '../crypto/pii.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { PostgresIdentityRepository } from './pg-repository.ts';
import { InMemoryIdentityRepository } from './repository.ts';
import { OtpService } from './otp.ts';
import { PasskeyService } from './passkeys.ts';
import { STEP_UP_TTL_MS, StepUpService, requireStepUp } from './step-up.ts';
import { TokenService, generateSigningKey } from './tokens.ts';

async function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const port = new AuthSimulator(clock);
  const otp = new OtpService(port, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  const passkeys = new PasskeyService(port, repo, tokens, clock, otp);
  const stepUp = new StepUpService(port, repo, clock);
  const { otpId } = await otp.start({ phone: '+972501234567', locale: 'en' });
  const v = await otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const s1 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'x' });
  const s2 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'x', response: await device.register(s1.options!) });
  const principal = await tokens.verifyAccess(s2.tokens!.accessToken);
  return { clock, repo, port, device, stepUp, principal };
}

describe('StepUpService (REQ-AUTH-006)', () => {
  it('a fresh passkey assertion yields a step-up token valid for 5 minutes, bound to the session', async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const step2 = await s.stepUp.complete(s.principal, await s.device.authenticate(step1.options));
    expect(Date.parse(step2.expiresAt) - s.clock.now().getTime()).toBe(STEP_UP_TTL_MS);
    const req = makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': step2.stepUpToken }, principal: s.principal, now: s.clock.now() });
    await expect(requireStepUp(s.stepUp, req)).resolves.toBeUndefined();
  });

  it('a session older than 5 minutes without step-up is refused with STEP_UP_REQUIRED', async () => {
    const s = await setup();
    s.clock.advance(6 * 60_000);
    const req = makeRequest({ method: 'POST', path: '/transfers', principal: s.principal, now: s.clock.now() });
    await expect(requireStepUp(s.stepUp, req)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('a step-up token expires after 5 minutes exactly', async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const { stepUpToken } = await s.stepUp.complete(s.principal, await s.device.authenticate(step1.options));
    const at = (ms: number) => makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': stepUpToken }, principal: s.principal, now: new Date(s.clock.now().getTime() + ms) });
    await expect(requireStepUp(s.stepUp, at(STEP_UP_TTL_MS))).resolves.toBeUndefined();
    await expect(requireStepUp(s.stepUp, at(STEP_UP_TTL_MS + 1))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it("a step-up token from another session, or a forged one, is refused", async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const { stepUpToken } = await s.stepUp.complete(s.principal, await s.device.authenticate(step1.options));
    const other = { ...s.principal, sessionId: 'another-session' };
    const req = makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': stepUpToken }, principal: other, now: s.clock.now() });
    await expect(requireStepUp(s.stepUp, req)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const forged = makeRequest({ method: 'POST', path: '/transfers', headers: { 'X-Step-Up': 'su_forged' }, principal: s.principal, now: s.clock.now() });
    await expect(requireStepUp(s.stepUp, forged)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('a bad or replayed assertion never produces a token', async () => {
    const s = await setup();
    const step1 = await s.stepUp.start(s.principal);
    const assertion = await s.device.authenticate(step1.options);
    await s.stepUp.complete(s.principal, assertion);
    await expect(s.stepUp.complete(s.principal, assertion)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

// T-0682: two API tasks over one database. A ceremony started on one finishes on the other, and a token
// minted on one is honoured by the other; nothing of either lives in a process.
describe('StepUpService across two instances (T-0682)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  async function twoInstances() {
    const clock = fixedClock() as AdvanceableClock;
    const pii = createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) });
    // One simulator: it stands in for the WebAuthn library, whose challenge check is not our process state.
    const port = new AuthSimulator(clock);
    const make = () => {
      const repo = new PostgresIdentityRepository(db, pii);
      return { repo, stepUp: new StepUpService(port, repo, clock) };
    };
    const a = make();
    const b = make();
    // Sign up through A's services; the account, passkey and session are rows both instances see.
    const otp = new OtpService(port, a.repo, clock);
    const tokens = new TokenService(a.repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
    const passkeys = new PasskeyService(port, a.repo, tokens, clock, otp);
    const { otpId } = await otp.start({ phone: `+97250${String(2_000_000 + Math.floor(Math.random() * 999_999))}`, locale: 'en' });
    const v = await otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
    const device = new SimPasskeyDevice();
    const s1 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'x' });
    const s2 = await passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'x', response: await device.register(s1.options!) });
    const principal = await tokens.verifyAccess(s2.tokens!.accessToken);
    const guard = (stepUp: StepUpService, token: string | undefined, afterMs = 0) =>
      requireStepUp(stepUp, makeRequest({ method: 'POST', path: '/transfers', ...(token ? { headers: { 'X-Step-Up': token } } : {}), principal, now: new Date(clock.now().getTime() + afterMs) }));
    return { clock, a, b, device, principal, guard };
  }

  it('starts on A and completes on B, and the token minted on B passes requireStepUp on A and on B', async () => {
    const t = await twoInstances();
    const step1 = await t.a.stepUp.start(t.principal);
    const { stepUpToken } = await t.b.stepUp.complete(t.principal, await t.device.authenticate(step1.options));
    await expect(t.guard(t.a.stepUp, stepUpToken)).resolves.toBeUndefined();
    await expect(t.guard(t.b.stepUp, stepUpToken)).resolves.toBeUndefined();
  });

  it('a token minted on A passes on B until it expires after STEP_UP_TTL_MS, and not a wrong or absent one', async () => {
    const t = await twoInstances();
    const step1 = await t.a.stepUp.start(t.principal);
    const { stepUpToken } = await t.a.stepUp.complete(t.principal, await t.device.authenticate(step1.options));
    await expect(t.guard(t.b.stepUp, stepUpToken, STEP_UP_TTL_MS)).resolves.toBeUndefined();
    await expect(t.guard(t.b.stepUp, 'su_forged')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(t.guard(t.b.stepUp, undefined)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(t.guard(t.b.stepUp, stepUpToken, STEP_UP_TTL_MS + 1)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('a ceremony is single-use across instances: a second complete, on either, fails', async () => {
    const t = await twoInstances();
    const step1 = await t.a.stepUp.start(t.principal);
    const assertion = await t.device.authenticate(step1.options);
    await t.b.stepUp.complete(t.principal, assertion);
    await expect(t.a.stepUp.complete(t.principal, assertion)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(t.b.stepUp.complete(t.principal, assertion)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a ceremony older than 60 seconds is refused on the other instance', async () => {
    const t = await twoInstances();
    const step1 = await t.a.stepUp.start(t.principal);
    const assertion = await t.device.authenticate(step1.options);
    t.clock.advance(60_001);
    await expect(t.b.stepUp.complete(t.principal, assertion)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('keeps no usable token at rest: only its hash', async () => {
    const t = await twoInstances();
    const step1 = await t.a.stepUp.start(t.principal);
    const { stepUpToken } = await t.a.stepUp.complete(t.principal, await t.device.authenticate(step1.options));
    const rows = await db.query(`select * from identity.step_up_token where session_id = $1`, [t.principal.sessionId]);
    expect(JSON.stringify(rows.rows)).not.toContain(stepUpToken);
    expect(rows.rows).toHaveLength(1);
  });

  it('runs under club_app with the grants the migration gives it', async () => {
    await db.asRole('club_app', async (asApp) => {
      const pii = createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) });
      const repo = new PostgresIdentityRepository({ ...db, query: asApp.query, transaction: (fn) => fn(asApp) }, pii);
      const now = '2026-11-10T08:00:00.000Z';
      await repo.saveCeremony({ ceremonyId: '0192f0a0-0000-7000-8000-000000000001', kind: 'step_up', key: 'grant-s', partyId: 'p', options: { challenge: 'c' }, issuedAt: now }, now);
      expect((await repo.takeCeremony('step_up', 'grant-s', now))?.options).toEqual({ challenge: 'c' });
      await repo.putStepUp({ sessionId: 'grant-s', tokenHash: 'h', expiresAt: now }, now);
      await repo.deleteStepUp('grant-s');
      expect(await repo.findStepUp('grant-s')).toBeUndefined();
    });
  });
});

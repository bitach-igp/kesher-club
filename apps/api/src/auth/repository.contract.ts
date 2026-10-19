// The IdentityRepository contract (T-0119): one suite, run against every implementation, so the
// in-memory repository the unit tests use and the Postgres one production uses cannot drift apart.
// Times are full ISO strings with milliseconds, as the auth services write them.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IdentityRepository, SessionFamily } from './repository.ts';

const T0 = '2026-10-19T08:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
let seq = 0;
const phone = (): string => `+97250${String(1_000_000 + ++seq).slice(-7)}`;

export function identityRepositoryContract(name: string, make: () => Promise<IdentityRepository>): void {
  describe(`IdentityRepository contract: ${name}`, () => {
    it('creates a member and finds them by phone and by party id; status changes stick', async () => {
      const repo = await make();
      const p = phone();
      const user = { partyId: randomUUID(), phone: p, status: 'pending' as const, roles: ['member'], createdAt: T0 };
      await repo.createUser(user);
      expect(await repo.findUserByPhone(p)).toEqual(user);
      expect(await repo.findUser(user.partyId)).toEqual(user);
      expect(await repo.findUserByPhone(phone())).toBeUndefined();
      await repo.setUserStatus(user.partyId, 'restricted');
      expect((await repo.findUser(user.partyId))?.status).toBe('restricted');
    });

    it('counts OTP starts per phone from a point in time', async () => {
      const repo = await make();
      const [a, b] = [phone(), phone()];
      for (const [p, m] of [[a, 0], [a, 5], [a, 10], [b, 6]] as const) await repo.recordOtpStart({ otpId: randomUUID(), phone: p, startedAt: at(m) });
      expect(await repo.countOtpStarts(a, at(5))).toBe(2);
      expect(await repo.countOtpStarts(a, at(0))).toBe(3);
      expect(await repo.countOtpStarts(b, at(0))).toBe(1);
      expect(await repo.countOtpStarts(phone(), at(0))).toBe(0);
    });

    it('gives an OTP session out once and only once', async () => {
      const repo = await make();
      const p = phone();
      await repo.saveOtpSession({ token: 'otp-token-1', phone: p, purpose: 'recovery', expiresAt: at(10) });
      expect(await repo.takeOtpSession('otp-token-1')).toEqual({ token: 'otp-token-1', phone: p, purpose: 'recovery', expiresAt: at(10) });
      expect(await repo.takeOtpSession('otp-token-1')).toBeUndefined();
      expect(await repo.takeOtpSession('never-issued')).toBeUndefined();
    });

    it('stores passkeys, finds them, updates the counter and removes them all for a member', async () => {
      const repo = await make();
      const partyId = randomUUID();
      const key = (n: number) => ({ credentialId: `cred-${partyId}-${n}`, partyId, publicKey: `pk-${n}`, counter: 0, deviceId: `dev-${n}`, deviceName: `Zvi's iPhone ${n}`, createdAt: at(n) });
      await repo.addPasskey(key(1));
      await repo.addPasskey(key(2));
      expect(await repo.listPasskeys(partyId)).toEqual([key(1), key(2)]);
      await repo.updatePasskeyCounter(key(1).credentialId, 7, at(30));
      expect(await repo.findPasskey(key(1).credentialId)).toEqual({ ...key(1), counter: 7, lastUsedAt: at(30) });
      await repo.removePasskeys(partyId);
      expect(await repo.listPasskeys(partyId)).toEqual([]);
      expect(await repo.findPasskey(key(2).credentialId)).toBeUndefined();
    });

    it('reports a device as new only the first time, and keeps its push token when a later visit has none', async () => {
      const repo = await make();
      const partyId = randomUUID();
      expect(await repo.upsertDevice({ partyId, deviceId: 'd1', firstSeenAt: at(0), lastSeenAt: at(0), pushToken: 'ExponentPushToken[abc]' })).toEqual({ isNew: true });
      expect(await repo.upsertDevice({ partyId, deviceId: 'd1', firstSeenAt: at(9), lastSeenAt: at(9) })).toEqual({ isNew: false });
      expect(await repo.upsertDevice({ partyId: randomUUID(), deviceId: 'd1', firstSeenAt: at(1), lastSeenAt: at(1) })).toEqual({ isNew: true });
      expect(await repo.listDevices(partyId)).toEqual([{ partyId, deviceId: 'd1', firstSeenAt: at(0), lastSeenAt: at(9), pushToken: 'ExponentPushToken[abc]' }]);
    });

    it('rotates a refresh family, finds it by the current and by a rotated hash, and revokes it once', async () => {
      const repo = await make();
      const partyId = randomUUID();
      const s: SessionFamily = { sessionId: randomUUID(), partyId, deviceId: 'd1', roles: ['member'], currentRefreshHash: `h0-${partyId}`, rotatedHashes: [], createdAt: at(0), refreshExpiresAt: at(60 * 24 * 30) };
      await repo.createSession(s);
      await repo.rotateSession(s.sessionId, `h1-${partyId}`, `h0-${partyId}`);
      await repo.rotateSession(s.sessionId, `h2-${partyId}`, `h1-${partyId}`);
      const rotated = { ...s, currentRefreshHash: `h2-${partyId}`, rotatedHashes: [`h0-${partyId}`, `h1-${partyId}`] };
      expect(await repo.findSession(s.sessionId)).toEqual(rotated);
      expect(await repo.findSessionByRefreshHash(`h2-${partyId}`)).toEqual({ session: rotated, isCurrent: true });
      expect(await repo.findSessionByRefreshHash(`h0-${partyId}`)).toEqual({ session: rotated, isCurrent: false });
      expect(await repo.findSessionByRefreshHash('unknown')).toBeUndefined();

      await repo.revokeSession(s.sessionId, 'refresh_reuse', at(5));
      await repo.revokeSession(s.sessionId, 'later', at(6));
      expect(await repo.findSession(s.sessionId)).toEqual({ ...rotated, revokedAt: at(5), revokedReason: 'refresh_reuse' });

      const other: SessionFamily = { ...s, sessionId: randomUUID(), deviceId: 'd2', currentRefreshHash: `x0-${partyId}`, createdAt: at(1) };
      await repo.createSession(other);
      expect((await repo.listSessions(partyId)).map((x) => x.sessionId)).toEqual([s.sessionId, other.sessionId]);
    });

    it('sets and replaces a recovery restriction', async () => {
      const repo = await make();
      const partyId = randomUUID();
      expect(await repo.getRestriction(partyId)).toBeUndefined();
      await repo.setRestriction(partyId, at(60 * 24), 'otp_recovery');
      await repo.setRestriction(partyId, at(60 * 48), 'otp_recovery');
      expect(await repo.getRestriction(partyId)).toMatchObject({ partyId, until: at(60 * 48), reason: 'otp_recovery', createdAt: expect.any(String) });
    });
  });
}

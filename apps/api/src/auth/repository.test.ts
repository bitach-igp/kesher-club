// T-0119: the identity contract against both repositories, and what only Postgres has to prove:
// nothing sensitive in clear at rest, one phone per member, and atomic OTP take.
import { randomBytes, randomUUID } from 'node:crypto';
import { Secret } from '@kesher/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPiiCipher } from '../crypto/pii.ts';
import { isPgError, PG } from '../db.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { PostgresIdentityRepository } from './pg-repository.ts';
import { identityRepositoryContract } from './repository.contract.ts';
import { InMemoryIdentityRepository } from './repository.ts';

let db: TestDatabase;
const pii = createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) });

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

identityRepositoryContract('in memory', async () => new InMemoryIdentityRepository());
identityRepositoryContract('Postgres', async () => new PostgresIdentityRepository(db, pii));

describe('PostgresIdentityRepository at rest (T-0119)', () => {
  const dump = async (): Promise<string> => {
    const tables = ['user_account', 'otp_start', 'otp_session', 'passkey', 'device', 'session', 'session_rotated_hash', 'restriction'];
    const parts = await Promise.all(tables.map(async (t) => JSON.stringify((await db.query(`select * from identity.${t}`)).rows, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))));
    return parts.join('\n');
  };

  it('keeps no phone, device name, push token or OTP token in clear', async () => {
    const repo = new PostgresIdentityRepository(db, pii);
    const partyId = randomUUID();
    await repo.createUser({ partyId, phone: '+972541112233', status: 'active', roles: ['member'], createdAt: '2026-10-19T08:00:00.000Z' });
    await repo.recordOtpStart({ otpId: 'provider-otp-id-77', phone: '+972541112233', startedAt: '2026-10-19T08:00:00.000Z' });
    await repo.saveOtpSession({ token: 'otp-session-secret-77', phone: '+972541112233', purpose: 'register', expiresAt: '2026-10-19T08:10:00.000Z' });
    await repo.addPasskey({ credentialId: `c-${partyId}`, partyId, publicKey: 'pk', counter: 0, deviceId: 'd', deviceName: 'Miriam Cohen iPad', createdAt: '2026-10-19T08:00:00.000Z' });
    await repo.upsertDevice({ partyId, deviceId: 'd', firstSeenAt: '2026-10-19T08:00:00.000Z', lastSeenAt: '2026-10-19T08:00:00.000Z', pushToken: 'ExponentPushToken[secret-77]' });
    const all = await dump();
    for (const clear of ['972541112233', 'Miriam Cohen', 'secret-77', 'provider-otp-id-77']) expect(all).not.toContain(clear);
    expect((await repo.findUserByPhone('+972541112233'))?.partyId).toBe(partyId);
  });

  it('allows one member per phone', async () => {
    const repo = new PostgresIdentityRepository(db, pii);
    const user = { phone: '+972549998877', status: 'pending' as const, roles: ['member'], createdAt: '2026-10-19T08:00:00.000Z' };
    await repo.createUser({ ...user, partyId: randomUUID() });
    const err = await repo.createUser({ ...user, partyId: randomUUID() }).catch((e: unknown) => e);
    expect(isPgError(err, PG.UNIQUE_VIOLATION)).toBe(true);
  });

  it('hands an OTP session to exactly one of two concurrent takers', async () => {
    const repo = new PostgresIdentityRepository(db, pii);
    await repo.saveOtpSession({ token: 'race-token', phone: '+972540000001', purpose: 'register', expiresAt: '2026-10-19T08:10:00.000Z' });
    const results = await Promise.all([repo.takeOtpSession('race-token'), repo.takeOtpSession('race-token')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('runs under club_app with the grants the migration gives it', async () => {
    await db.asRole('club_app', async (asApp) => {
      const repo = new PostgresIdentityRepository({ ...db, query: asApp.query, transaction: (fn) => fn(asApp) }, pii);
      const partyId = randomUUID();
      await repo.createUser({ partyId, phone: '+972540000002', status: 'pending', roles: ['member'], createdAt: '2026-10-19T08:00:00.000Z' });
      await repo.setUserStatus(partyId, 'active');
      await repo.addPasskey({ credentialId: `g-${partyId}`, partyId, publicKey: 'pk', counter: 0, deviceId: 'd', deviceName: 'n', createdAt: '2026-10-19T08:00:00.000Z' });
      await repo.removePasskeys(partyId);
      const err = await asApp.query(`delete from identity.user_account where party_id = $1`, [partyId]).catch((e: unknown) => e);
      expect(isPgError(err, PG.INSUFFICIENT_PRIVILEGE)).toBe(true);
    });
  });
});

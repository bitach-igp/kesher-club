// Identity repository on Postgres (T-0119, REQ-AUTH-001, REQ-AUTH-007) over identity.* (migration
// identity/0003). It satisfies the same contract as InMemoryIdentityRepository; repository.contract.ts
// runs one suite against both. PII is sealed with the T-0024 cipher before it reaches SQL: the phone
// (found and kept unique through its blind index), a passkey's device name and a device's push token.
// Tokens arrive here already hashed (refresh) or are hashed on the way in (OTP session), so no table
// holds a usable credential. Each write that the in-memory version does as read-then-write is one
// statement here, so two API instances cannot interleave inside it.
import { createHash } from 'node:crypto';
import type { PiiCipher } from '../crypto/pii.ts';
import type { Database } from '../db.ts';
import type { Device, IdentityRepository, OtpRecord, OtpSession, Restriction, SessionFamily, StoredPasskey, UserAccount, UserStatus } from './repository.ts';

/** Column names double as the cipher's context, so a sealed value only opens where it was written. */
const COL = {
  userPhone: 'identity.user_account.phone',
  otpStartPhone: 'identity.otp_start.phone',
  otpSessionPhone: 'identity.otp_session.phone',
  passkeyDeviceName: 'identity.passkey.device_name',
  devicePushToken: 'identity.device.push_token',
} as const;

const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('base64url');

interface UserRow { party_id: string; phone_sealed: Uint8Array; status: UserStatus; roles: string[]; created_at: Date }
interface PasskeyRow { credential_id: string; party_id: string; public_key: string; counter: string; device_id: string; device_name_sealed: Uint8Array; created_at: Date; last_used_at: Date | null }
interface DeviceRow { party_id: string; device_id: string; first_seen_at: Date; last_seen_at: Date; push_token_sealed: Uint8Array | null }
interface SessionRow { session_id: string; party_id: string; device_id: string; roles: string[]; current_refresh_hash: string; rotated: string[]; created_at: Date; refresh_expires_at: Date; revoked_at: Date | null; revoked_reason: string | null }

const SESSION_COLUMNS = `s.session_id, s.party_id, s.device_id, s.roles, s.current_refresh_hash, s.created_at, s.refresh_expires_at, s.revoked_at, s.revoked_reason,
  array(select r.refresh_hash from identity.session_rotated_hash r where r.session_id = s.session_id order by r.rotated_at, r.refresh_hash) as rotated`;

export class PostgresIdentityRepository implements IdentityRepository {
  private readonly db: Database;
  private readonly pii: PiiCipher;
  constructor(db: Database, pii: PiiCipher) {
    this.db = db;
    this.pii = pii;
  }

  // ---- members ----

  async findUserByPhone(phone: string): Promise<UserAccount | undefined> {
    const r = await this.db.query<UserRow>(`select party_id, phone_sealed, status, roles, created_at from identity.user_account where phone_index = $1`, [this.pii.index(phone, COL.userPhone)]);
    return r.rows[0] && this.user(r.rows[0]);
  }

  async findUser(partyId: string): Promise<UserAccount | undefined> {
    const r = await this.db.query<UserRow>(`select party_id, phone_sealed, status, roles, created_at from identity.user_account where party_id = $1`, [partyId]);
    return r.rows[0] && this.user(r.rows[0]);
  }

  async createUser(user: UserAccount): Promise<UserAccount> {
    await this.db.query(`insert into identity.user_account (party_id, phone_index, phone_sealed, status, roles, created_at) values ($1, $2, $3, $4, $5, $6)`, [
      user.partyId,
      this.pii.index(user.phone, COL.userPhone),
      this.pii.seal(user.phone, COL.userPhone),
      user.status,
      [...user.roles],
      user.createdAt,
    ]);
    return user;
  }

  async setUserStatus(partyId: string, status: UserStatus): Promise<void> {
    await this.db.query(`update identity.user_account set status = $2 where party_id = $1`, [partyId, status]);
  }

  // ---- OTP ----

  async recordOtpStart(record: OtpRecord): Promise<void> {
    // The provider's otp id is not kept: counting starts per phone is all this table is for.
    await this.db.query(`insert into identity.otp_start (phone_index, started_at) values ($1, $2)`, [this.pii.index(record.phone, COL.otpStartPhone), record.startedAt]);
  }

  async countOtpStarts(phone: string, since: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(`select count(*)::int as n from identity.otp_start where phone_index = $1 and started_at >= $2`, [this.pii.index(phone, COL.otpStartPhone), since]);
    return r.rows[0]?.n ?? 0;
  }

  async saveOtpSession(session: OtpSession): Promise<void> {
    await this.db.query(
      `insert into identity.otp_session (token_hash, phone_sealed, purpose, expires_at, consumed_at) values ($1, $2, $3, $4, $5)
       on conflict (token_hash) do update set phone_sealed = excluded.phone_sealed, purpose = excluded.purpose, expires_at = excluded.expires_at, consumed_at = excluded.consumed_at`,
      [tokenHash(session.token), this.pii.seal(session.phone, COL.otpSessionPhone), session.purpose, session.expiresAt, session.consumedAt ?? null],
    );
  }

  async takeOtpSession(token: string): Promise<OtpSession | undefined> {
    // One statement: of two concurrent takes, exactly one gets the session.
    const r = await this.db.query<{ phone_sealed: Uint8Array; purpose: OtpSession['purpose']; expires_at: Date }>(
      `update identity.otp_session set consumed_at = now() where token_hash = $1 and consumed_at is null returning phone_sealed, purpose, expires_at`,
      [tokenHash(token)],
    );
    const row = r.rows[0];
    return row && { token, phone: this.pii.open(row.phone_sealed, COL.otpSessionPhone), purpose: row.purpose, expiresAt: iso(row.expires_at) };
  }

  // ---- passkeys ----

  async addPasskey(p: StoredPasskey): Promise<void> {
    await this.db.query(
      `insert into identity.passkey (credential_id, party_id, public_key, counter, device_id, device_name_sealed, created_at, last_used_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (credential_id) do update set party_id = excluded.party_id, public_key = excluded.public_key, counter = excluded.counter, device_id = excluded.device_id,
         device_name_sealed = excluded.device_name_sealed, created_at = excluded.created_at, last_used_at = excluded.last_used_at`,
      [p.credentialId, p.partyId, p.publicKey, p.counter, p.deviceId, this.pii.seal(p.deviceName, COL.passkeyDeviceName), p.createdAt, p.lastUsedAt ?? null],
    );
  }

  async listPasskeys(partyId: string): Promise<readonly StoredPasskey[]> {
    const r = await this.db.query<PasskeyRow>(`select * from identity.passkey where party_id = $1 order by created_at, credential_id`, [partyId]);
    return r.rows.map((row) => this.passkey(row));
  }

  async findPasskey(credentialId: string): Promise<StoredPasskey | undefined> {
    const r = await this.db.query<PasskeyRow>(`select * from identity.passkey where credential_id = $1`, [credentialId]);
    return r.rows[0] && this.passkey(r.rows[0]);
  }

  async updatePasskeyCounter(credentialId: string, counter: number, usedAt: string): Promise<void> {
    await this.db.query(`update identity.passkey set counter = $2, last_used_at = $3 where credential_id = $1`, [credentialId, counter, usedAt]);
  }

  async removePasskeys(partyId: string): Promise<void> {
    await this.db.query(`delete from identity.passkey where party_id = $1`, [partyId]);
  }

  // ---- devices ----

  async upsertDevice(d: Device): Promise<{ isNew: boolean }> {
    // `xmax = 0` holds only for a row this statement inserted, so isNew is decided atomically.
    const r = await this.db.query<{ inserted: boolean }>(
      `insert into identity.device (party_id, device_id, first_seen_at, last_seen_at, push_token_sealed) values ($1, $2, $3, $4, $5)
       on conflict (party_id, device_id) do update set last_seen_at = excluded.last_seen_at, push_token_sealed = coalesce(excluded.push_token_sealed, identity.device.push_token_sealed)
       returning (xmax = 0) as inserted`,
      [d.partyId, d.deviceId, d.firstSeenAt, d.lastSeenAt, d.pushToken ? this.pii.seal(d.pushToken, COL.devicePushToken) : null],
    );
    return { isNew: r.rows[0]?.inserted === true };
  }

  async listDevices(partyId: string): Promise<readonly Device[]> {
    const r = await this.db.query<DeviceRow>(`select * from identity.device where party_id = $1 order by first_seen_at, device_id`, [partyId]);
    return r.rows.map((row) => ({
      partyId: row.party_id,
      deviceId: row.device_id,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      ...(row.push_token_sealed ? { pushToken: this.pii.open(row.push_token_sealed, COL.devicePushToken) } : {}),
    }));
  }

  // ---- sessions (REQ-AUTH-007) ----

  async createSession(s: SessionFamily): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into identity.session (session_id, party_id, device_id, roles, current_refresh_hash, created_at, refresh_expires_at, revoked_at, revoked_reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [s.sessionId, s.partyId, s.deviceId, [...s.roles], s.currentRefreshHash, s.createdAt, s.refreshExpiresAt, s.revokedAt ?? null, s.revokedReason ?? null],
      );
      for (const h of s.rotatedHashes) await tx.query(`insert into identity.session_rotated_hash (refresh_hash, session_id) values ($1, $2)`, [h, s.sessionId]);
    });
  }

  async findSession(sessionId: string): Promise<SessionFamily | undefined> {
    const r = await this.db.query<SessionRow>(`select ${SESSION_COLUMNS} from identity.session s where s.session_id = $1`, [sessionId]);
    return r.rows[0] && session(r.rows[0]);
  }

  async findSessionByRefreshHash(hash: string): Promise<{ session: SessionFamily; isCurrent: boolean } | undefined> {
    const r = await this.db.query<SessionRow & { is_current: boolean }>(
      `select ${SESSION_COLUMNS}, s.current_refresh_hash = $1 as is_current from identity.session s
        where s.current_refresh_hash = $1 or s.session_id = (select session_id from identity.session_rotated_hash where refresh_hash = $1)`,
      [hash],
    );
    const row = r.rows[0];
    return row && { session: session(row), isCurrent: row.is_current };
  }

  async rotateSession(sessionId: string, newHash: string, previousHash: string): Promise<void> {
    // One statement: the old hash moves to the rotated table as the new one becomes current.
    await this.db.query(
      `with s as (update identity.session set current_refresh_hash = $2 where session_id = $1 returning session_id)
       insert into identity.session_rotated_hash (refresh_hash, session_id) select $3, session_id from s on conflict (refresh_hash) do nothing`,
      [sessionId, newHash, previousHash],
    );
  }

  async revokeSession(sessionId: string, reason: string, at: string): Promise<void> {
    await this.db.query(`update identity.session set revoked_at = $3, revoked_reason = $2 where session_id = $1 and revoked_at is null`, [sessionId, reason, at]);
  }

  async listSessions(partyId: string): Promise<readonly SessionFamily[]> {
    const r = await this.db.query<SessionRow>(`select ${SESSION_COLUMNS} from identity.session s where s.party_id = $1 order by s.created_at, s.session_id`, [partyId]);
    return r.rows.map(session);
  }

  // ---- restrictions (REQ-AUTH-003) ----

  async setRestriction(partyId: string, until: string, reason: Restriction['reason']): Promise<void> {
    await this.db.query(
      `insert into identity.restriction (party_id, until, reason) values ($1, $2, $3)
       on conflict (party_id) do update set until = excluded.until, reason = excluded.reason, created_at = now()`,
      [partyId, until, reason],
    );
  }

  async getRestriction(partyId: string): Promise<Restriction | undefined> {
    const r = await this.db.query<{ party_id: string; until: Date; reason: Restriction['reason']; created_at: Date }>(`select * from identity.restriction where party_id = $1`, [partyId]);
    const row = r.rows[0];
    return row && { partyId: row.party_id, until: iso(row.until), reason: row.reason, createdAt: iso(row.created_at) };
  }

  // ---- rows to the contract's shapes ----

  private user(row: UserRow): UserAccount {
    return { partyId: row.party_id, phone: this.pii.open(row.phone_sealed, COL.userPhone), status: row.status, roles: row.roles, createdAt: iso(row.created_at) };
  }

  private passkey(row: PasskeyRow): StoredPasskey {
    return {
      credentialId: row.credential_id,
      partyId: row.party_id,
      publicKey: row.public_key,
      counter: Number(row.counter),
      deviceId: row.device_id,
      deviceName: this.pii.open(row.device_name_sealed, COL.passkeyDeviceName),
      createdAt: iso(row.created_at),
      ...(row.last_used_at ? { lastUsedAt: iso(row.last_used_at) } : {}),
    };
  }
}

function session(row: SessionRow): SessionFamily {
  return {
    sessionId: row.session_id,
    partyId: row.party_id,
    deviceId: row.device_id,
    roles: row.roles,
    currentRefreshHash: row.current_refresh_hash,
    rotatedHashes: row.rotated,
    createdAt: iso(row.created_at),
    refreshExpiresAt: iso(row.refresh_expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {}),
  };
}

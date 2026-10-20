// Identity repository (identity.user_account, auth.passkey, auth.session, auth.restriction,
// identity.device). The interface is what the Postgres implementation must satisfy; the in-memory
// implementation backs unit tests and the preview simulators. PII fields are kept to what REQ-AUTH
// needs (constitution art. 9); the phone is stored once, as E.164.

export type UserStatus = 'pending' | 'active' | 'restricted' | 'closed';

export interface UserAccount {
  partyId: string;
  phone: string;
  status: UserStatus;
  roles: readonly string[];
  createdAt: string;
}

export interface StoredPasskey {
  credentialId: string;
  partyId: string;
  publicKey: string;
  counter: number;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface Device {
  partyId: string;
  deviceId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Push token for "new sign-in" notices; may be absent. */
  pushToken?: string;
}

/** One refresh-token family = one device session (REQ-AUTH-007). */
export interface SessionFamily {
  sessionId: string;
  partyId: string;
  deviceId: string;
  roles: readonly string[];
  /** Hash of the refresh token currently valid for this family. */
  currentRefreshHash: string;
  /** Hashes already rotated out; presenting one of these revokes the family. */
  rotatedHashes: readonly string[];
  createdAt: string;
  refreshExpiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

export interface Restriction {
  partyId: string;
  until: string;
  reason: 'otp_recovery';
  createdAt: string;
}

export interface OtpRecord {
  otpId: string;
  phone: string;
  startedAt: string;
}

export interface OtpSession {
  token: string;
  phone: string;
  purpose: 'register' | 'recovery';
  expiresAt: string;
  consumedAt?: string;
}

export interface IdentityRepository {
  findUserByPhone(phone: string): Promise<UserAccount | undefined>;
  findUser(partyId: string): Promise<UserAccount | undefined>;
  createUser(user: UserAccount): Promise<UserAccount>;
  setUserStatus(partyId: string, status: UserStatus): Promise<void>;
  /** Replaces the account's roles; sessions keep the roles they were issued with until the next sign-in (T-0924). */
  setUserRoles(partyId: string, roles: readonly string[]): Promise<void>;

  recordOtpStart(record: OtpRecord): Promise<void>;
  countOtpStarts(phone: string, since: string): Promise<number>;
  saveOtpSession(session: OtpSession): Promise<void>;
  takeOtpSession(token: string): Promise<OtpSession | undefined>;

  addPasskey(p: StoredPasskey): Promise<void>;
  listPasskeys(partyId: string): Promise<readonly StoredPasskey[]>;
  findPasskey(credentialId: string): Promise<StoredPasskey | undefined>;
  updatePasskeyCounter(credentialId: string, counter: number, usedAt: string): Promise<void>;
  removePasskeys(partyId: string): Promise<void>;

  upsertDevice(d: Device): Promise<{ isNew: boolean }>;
  listDevices(partyId: string): Promise<readonly Device[]>;

  createSession(s: SessionFamily): Promise<void>;
  findSession(sessionId: string): Promise<SessionFamily | undefined>;
  findSessionByRefreshHash(hash: string): Promise<{ session: SessionFamily; isCurrent: boolean } | undefined>;
  rotateSession(sessionId: string, newHash: string, previousHash: string): Promise<void>;
  revokeSession(sessionId: string, reason: string, at: string): Promise<void>;
  listSessions(partyId: string): Promise<readonly SessionFamily[]>;

  setRestriction(partyId: string, until: string, reason: Restriction['reason']): Promise<void>;
  getRestriction(partyId: string): Promise<Restriction | undefined>;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, UserAccount>();
  private readonly otpStarts: OtpRecord[] = [];
  private readonly otpSessions = new Map<string, OtpSession>();
  private readonly passkeys = new Map<string, StoredPasskey>();
  private readonly devices = new Map<string, Device>();
  private readonly sessions = new Map<string, SessionFamily>();
  private readonly restrictions = new Map<string, Restriction>();

  async findUserByPhone(phone: string) {
    return [...this.users.values()].find((u) => u.phone === phone);
  }
  async findUser(partyId: string) {
    return this.users.get(partyId);
  }
  async createUser(user: UserAccount) {
    this.users.set(user.partyId, user);
    return user;
  }
  async setUserStatus(partyId: string, status: UserStatus) {
    const u = this.users.get(partyId);
    if (u) this.users.set(partyId, { ...u, status });
  }

  async setUserRoles(partyId: string, roles: readonly string[]) {
    const u = this.users.get(partyId);
    if (u) this.users.set(partyId, { ...u, roles: [...roles] });
  }

  async recordOtpStart(record: OtpRecord) {
    this.otpStarts.push(record);
  }
  async countOtpStarts(phone: string, since: string) {
    return this.otpStarts.filter((r) => r.phone === phone && r.startedAt >= since).length;
  }
  async saveOtpSession(session: OtpSession) {
    this.otpSessions.set(session.token, session);
  }
  async takeOtpSession(token: string) {
    const s = this.otpSessions.get(token);
    if (!s || s.consumedAt) return undefined;
    this.otpSessions.set(token, { ...s, consumedAt: new Date().toISOString() });
    return s;
  }

  async addPasskey(p: StoredPasskey) {
    this.passkeys.set(p.credentialId, p);
  }
  async listPasskeys(partyId: string) {
    return [...this.passkeys.values()].filter((p) => p.partyId === partyId);
  }
  async findPasskey(credentialId: string) {
    return this.passkeys.get(credentialId);
  }
  async updatePasskeyCounter(credentialId: string, counter: number, usedAt: string) {
    const p = this.passkeys.get(credentialId);
    if (p) this.passkeys.set(credentialId, { ...p, counter, lastUsedAt: usedAt });
  }
  async removePasskeys(partyId: string) {
    for (const [id, p] of this.passkeys) if (p.partyId === partyId) this.passkeys.delete(id);
  }

  async upsertDevice(d: Device) {
    const key = `${d.partyId}|${d.deviceId}`;
    const prior = this.devices.get(key);
    this.devices.set(key, prior ? { ...prior, lastSeenAt: d.lastSeenAt, ...(d.pushToken ? { pushToken: d.pushToken } : {}) } : d);
    return { isNew: !prior };
  }
  async listDevices(partyId: string) {
    return [...this.devices.values()].filter((d) => d.partyId === partyId);
  }

  async createSession(s: SessionFamily) {
    this.sessions.set(s.sessionId, s);
  }
  async findSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }
  async findSessionByRefreshHash(hash: string) {
    for (const s of this.sessions.values()) {
      if (s.currentRefreshHash === hash) return { session: s, isCurrent: true };
      if (s.rotatedHashes.includes(hash)) return { session: s, isCurrent: false };
    }
    return undefined;
  }
  async rotateSession(sessionId: string, newHash: string, previousHash: string) {
    const s = this.sessions.get(sessionId);
    if (s) this.sessions.set(sessionId, { ...s, currentRefreshHash: newHash, rotatedHashes: [...s.rotatedHashes, previousHash] });
  }
  async revokeSession(sessionId: string, reason: string, at: string) {
    const s = this.sessions.get(sessionId);
    if (s && !s.revokedAt) this.sessions.set(sessionId, { ...s, revokedAt: at, revokedReason: reason });
  }
  async listSessions(partyId: string) {
    return [...this.sessions.values()].filter((s) => s.partyId === partyId);
  }

  async setRestriction(partyId: string, until: string, reason: Restriction['reason']) {
    this.restrictions.set(partyId, { partyId, until, reason, createdAt: new Date().toISOString() });
  }
  async getRestriction(partyId: string) {
    return this.restrictions.get(partyId);
  }
}

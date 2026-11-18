// CrowdedMemberSubAccounts (T-0754, REQ-INS-022, REQ-WAL-002, ADR-018 option 2): MemberSubAccountPort over Crowded's REST API. A member's
// account is a SUB-ACCOUNT: a chapter under the nonprofit's chapter (`parentChapterId`, from T-0751), with its own deposit account.
// Flag: none of its own (the registry wiring is T-0709). The pattern is `createSubAccount` in institution-banking.ts (T-0695, T-0696),
// copied into a member class rather than widening the institution port.
//
// How the port's promises are kept on an API that gives less:
// - A sub-account create takes a body `idempotencyKey` (a strict UUID v4: `uuidFromKey` of ours) but never answers a repeat with the first
//   sub-account: a repeat is a 500, a full quota a 429 checked before the key (README, 2026-11-10). So the sub-account is looked up by its
//   exact name `Member {partyId}` (a uuid: no personal data, well under 255 characters) under the same parent BEFORE it is created, and
//   again after a create that ends unknown (a transport error, a 5xx or a 409): a retry after a lost response adopts the orphan and never
//   posts a second one. Nothing is retried here.
// - The vendor keeps only a name, and the name has no purpose in it, so one member with two purposes has two chapters of the same name.
//   Our own records (the KeyLedger) say which identity (party and purpose) each chapter was claimed for: a named chapter claimed for
//   another purpose of the same party is skipped, one claimed for another party is VALIDATION_FAILED and nothing is posted, and an
//   unclaimed one is an orphan and is adopted. With the ledger lost, two purposes of one member cannot be told apart at the vendor: the
//   orphan goes to whichever asks first and each purpose still ends with exactly one.
// - The identity (party and purpose) is the sub-account; the idempotency key is the retry. A second key for the same identity answers the
//   same refs and the current status whatever owner or invitation it carries. A reused key with different input is IDEMPOTENCY_CONFLICT,
//   except that a create that would be refused for quota answers QUOTA_EXCEEDED first, as the live API does: the vendor is asked with the
//   key's own wire key (a key it has seen answers 500 and makes nothing; a full quota answers 429).
// - Calls are serialized in this process, so two concurrent calls cannot both create. Across processes the name lookup is the guard.
// - Refs are `s:<chapter>` and `s:<chapter>:<account>` (map.ts). `subAccount` accepts only the first form, and only for a chapter whose
//   parent is the nonprofit: any other ref is UNKNOWN_ACCOUNT with no request made when it is malformed.
// - The owner's status is the fake's own field (`ownerStatus`); the live shape waits on Thursday's questions A and D. Where the vendor says
//   nothing (an adopted orphan), an owner reads as `active` and an invitation as `invited`.
// - Personal data is passed through and never persisted in clear: the KeyLedger holds only HMAC-SHA256 values under `hmacKey`, the party
//   id and vendor ids. The account number and routing number are never read into anything returned, logged or thrown. Errors carry fixed
//   text; Crowded's own message (which can echo what we sent) is never passed on. Crowded's text is untrusted data.
import { createHmac } from 'node:crypto';
import { money, type Money } from '@kesher/domain';
import {
  MemberSubAccountError,
  type EnsuredSubAccount,
  type EnsureSubAccountInput,
  type MemberSubAccountErrorCode,
  type MemberSubAccountPort,
  type MemberSubAccountStatus,
  type MemberSubAccountView,
  type SubAccountOwner,
  type SubAccountOwnerStatus,
} from '@kesher/ports';
import { CrowdedApiError, CrowdedTransportError, type CrowdedClient } from './client.ts';
import { guardLedger, InMemoryKeyLedger, type KeyLedger } from './institution-banking.ts';
import { fromCents, isRecord, parseSubAccountRef, str, subAccountRef, uuidFromKey } from './map.ts';

export interface CrowdedMemberSubAccountsOptions {
  client: CrowdedClient;
  /** The nonprofit's chapter id at Crowded (T-0751): the parent of every member sub-account. Required. */
  parentChapterId: string;
  /** A secret of at least 32 characters (from configuration; there is no default) keying every hash this adapter stores. */
  hmacKey: string;
  /** Remembers key, identity and claim bindings. In memory by default; production wires one that persists (as for the other Crowded adapters). */
  ledger?: KeyLedger;
  /** For the date-of-birth range check. */
  now?: () => Date;
}

interface Valid {
  partyId: string;
  purpose: string;
  owner?: SubAccountOwner;
  inviteEmail?: string;
}
/** The identity's binding: the chapter and how its owner stood when it was made. The deposit account is read each time. */
interface Binding {
  chapterId: string;
  ownerStatus: SubAccountOwnerStatus;
}
/** A key's record: `posted` is true when its wire key reached the vendor with a create that was made. */
interface KeyRecord {
  posted: boolean;
}
interface Claim {
  party: string;
  identity: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_PARTY = 128;
const MAX_PURPOSE = 200;
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const low = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const USD = (minor: bigint): Money => money(minor, 'USD');
const fail = (code: MemberSubAccountErrorCode, message: string): never => {
  throw new MemberSubAccountError(code, message);
};
const STATUS: Record<string, MemberSubAccountStatus> = { open: 'open', frozen: 'frozen', closed: 'closed' };
const OWNER_STATUS: Record<string, SubAccountOwnerStatus> = { active: 'active', invited: 'invited', pending: 'invited', sent: 'invited', failed: 'failed' };

function validDate(s: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) && Number(m[1]) >= 1900 && d.getTime() <= now.getTime();
}

export class CrowdedMemberSubAccounts implements MemberSubAccountPort {
  private readonly c: CrowdedClient;
  private readonly parent: string;
  private readonly secret: string;
  private readonly ledger: KeyLedger;
  private readonly now: () => Date;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: CrowdedMemberSubAccountsOptions) {
    if (typeof opts.hmacKey !== 'string' || opts.hmacKey.length < 32) throw new Error('CrowdedMemberSubAccounts needs an hmacKey of at least 32 characters');
    if (typeof opts.parentChapterId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(opts.parentChapterId)) throw new Error('CrowdedMemberSubAccounts needs the nonprofit parentChapterId');
    this.c = opts.client;
    this.parent = opts.parentChapterId;
    this.secret = opts.hmacKey;
    this.ledger = guardLedger(opts.ledger ?? new InMemoryKeyLedger(), () => fail('PROVIDER_UNAVAILABLE', 'The sub-account provider is not available'));
    this.now = opts.now ?? (() => new Date());
  }

  // ---- plumbing -----------------------------------------------------------------------------------------------

  /** Keyed hash, domain-separated by `scope`. */
  private mac(scope: string, ...parts: string[]): string {
    return createHmac('sha256', this.secret).update(JSON.stringify([scope, ...parts])).digest('hex');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Maps every failure to the port's set with fixed text. `missing` is the code for a 404; `refusal` maps a 400 or 422 to VALIDATION_FAILED. */
  private async call<T>(fn: () => Promise<T>, opts: { missing?: MemberSubAccountErrorCode; refusal?: boolean } = {}): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MemberSubAccountError) throw e;
      if (e instanceof CrowdedApiError) {
        if (e.isMissing && opts.missing) throw new MemberSubAccountError(opts.missing, 'Unknown sub-account');
        if (opts.refusal && (e.status === 400 || e.status === 422)) throw new MemberSubAccountError('VALIDATION_FAILED', 'The sub-account provider refused the details');
      }
      // Transport, auth, 429 (outside a create), 5xx, a malformed answer and anything unforeseen all fail secure.
      throw new MemberSubAccountError('PROVIDER_UNAVAILABLE', 'The sub-account provider is not available');
    }
  }

  // ---- ensureSubAccount ---------------------------------------------------------------------------------------

  async ensureSubAccount(input: EnsureSubAccountInput, idempotencyKey: string): Promise<EnsuredSubAccount> {
    const v = this.validate(input, idempotencyKey);
    return this.serial(() => this.ensure(v, idempotencyKey));
  }

  private async ensure(v: Valid, key: string): Promise<EnsuredSubAccount> {
    const identity = this.mac('identity', v.partyId, v.purpose);
    const ownerMac = v.owner ? this.mac('owner', v.owner.firstName, v.owner.lastName, v.owner.email, v.owner.mobile, v.owner.dateOfBirth ?? '') : this.mac('invite', v.inviteEmail ?? '');
    const inputMac = this.mac('input', identity, ownerMac);
    const keyK = `msub:key:${key}`;
    const idK = `msub:id:${identity}`;

    const bound = await this.ledger.get(keyK);
    const known = await this.ledger.get(idK);
    if (bound && bound.body !== inputMac) {
      // A create under this key would be refused for quota first (the live API checks it before the key): ask the vendor, once, with the
      // key's own wire key. A key it has seen makes nothing (500); only a known sub-account makes no create at all.
      if (!known && (bound.result as KeyRecord | undefined)?.posted) await this.call(() => this.probeQuota(v, key), { refusal: true });
      return fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used with different input');
    }

    let binding = known?.result as Binding | undefined;
    let posted = false;
    if (!binding) {
      const made = await this.call(() => this.findOrCreate(v, key, identity), { refusal: true });
      posted = made.posted;
      binding = { chapterId: made.chapterId, ownerStatus: made.ownerStatus };
      await this.ledger.put(`msub:claim:${this.parent}:${made.chapterId}`, { body: '', result: { party: v.partyId, identity } satisfies Claim });
      await this.ledger.put(idK, { body: '', result: binding });
    }

    const deposit = await this.call(() => this.deposit(binding!.chapterId));
    if (!bound) await this.ledger.put(keyK, { body: inputMac, result: { posted } satisfies KeyRecord });
    return { subAccountRef: subAccountRef(binding.chapterId), accountRef: subAccountRef(binding.chapterId, deposit.id), status: deposit.status, ownerStatus: binding.ownerStatus };
  }

  private validate(input: EnsureSubAccountInput, key: string): Valid {
    const i = input as Partial<Record<keyof EnsureSubAccountInput, unknown>>;
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) return fail('VALIDATION_FAILED', 'The idempotency key must be 8 to 128 characters');
    if (!text(i.partyId) || i.partyId.length > MAX_PARTY) return fail('VALIDATION_FAILED', 'partyId is required, at most 128 characters');
    if (typeof i.purpose !== 'string' || i.purpose.trim() === '') return fail('PURPOSE_REQUIRED', 'A purpose is required');
    const purpose = i.purpose.trim();
    if (purpose.length > MAX_PURPOSE) return fail('VALIDATION_FAILED', 'purpose is too long');
    const hasOwner = i.owner !== undefined && i.owner !== null;
    const hasInvite = i.inviteEmail !== undefined && i.inviteEmail !== null;
    if (hasOwner === hasInvite) return fail('VALIDATION_FAILED', 'Exactly one of owner and inviteEmail is required');
    const base = { partyId: i.partyId, purpose };
    if (hasInvite) {
      if (typeof i.inviteEmail !== 'string' || i.inviteEmail.length > MAX_EMAIL || !EMAIL.test(i.inviteEmail)) return fail('VALIDATION_FAILED', 'inviteEmail is not valid');
      return { ...base, inviteEmail: i.inviteEmail.toLowerCase() };
    }
    const o = i.owner as Partial<Record<keyof SubAccountOwner, unknown>>;
    if (typeof o !== 'object' || !text(o.firstName) || !text(o.lastName) || o.firstName.trim().length > MAX_NAME || o.lastName.trim().length > MAX_NAME) return fail('VALIDATION_FAILED', 'An owner needs a first and last name');
    if (typeof o.email !== 'string' || o.email.length > MAX_EMAIL || !EMAIL.test(o.email)) return fail('VALIDATION_FAILED', 'The owner email is not valid');
    if (typeof o.mobile !== 'string' || !E164.test(o.mobile)) return fail('VALIDATION_FAILED', 'The owner mobile must be E.164');
    if (o.dateOfBirth !== undefined && (typeof o.dateOfBirth !== 'string' || !validDate(o.dateOfBirth, this.now()))) return fail('VALIDATION_FAILED', 'dateOfBirth must be a past YYYY-MM-DD date');
    return {
      ...base,
      owner: { firstName: o.firstName.trim(), lastName: o.lastName.trim(), email: o.email.toLowerCase(), mobile: o.mobile, ...(o.dateOfBirth !== undefined ? { dateOfBirth: o.dateOfBirth } : {}) },
    };
  }

  /** The create body: exactly one of `owner` and `email`, the owner object only when it was given. */
  private body(v: Valid, wireKey: string): Record<string, unknown> {
    return { name: `Member ${v.partyId}`, ...(v.owner ? { owner: { ...v.owner } } : { email: v.inviteEmail }), idempotencyKey: wireKey };
  }

  private wireKey(key: string): string {
    return uuidFromKey(`member-sub:${key}`);
  }

  /** Throws QUOTA_EXCEEDED when the vendor is at its limit. Any other answer means the repeated key was refused, as it must be. */
  private async probeQuota(v: Valid, key: string): Promise<void> {
    try {
      await this.c.post(`/chapters/${this.parent}/subaccounts`, this.body(v, this.wireKey(key)));
    } catch (e) {
      if (e instanceof CrowdedApiError && e.status === 429) fail('QUOTA_EXCEEDED', 'The sub-account limit has been reached');
      // A key the vendor has seen answers 500 and makes nothing. (An answer that did make one is an orphan: the name lookup adopts it.)
    }
  }

  private async findOrCreate(v: Valid, key: string, identity: string): Promise<{ chapterId: string; ownerStatus: SubAccountOwnerStatus; posted: boolean }> {
    const name = `Member ${v.partyId}`;
    const fallback: SubAccountOwnerStatus = v.owner ? 'active' : 'invited';
    const found = await this.findByName(name, v.partyId, identity);
    if (found) return { chapterId: found.id, ownerStatus: found.ownerStatus ?? fallback, posted: false };
    try {
      const r = await this.c.post(`/chapters/${this.parent}/subaccounts`, this.body(v, this.wireKey(key)));
      if (!isRecord(r.data)) return fail('PROVIDER_UNAVAILABLE', 'The sub-account provider sent an unreadable answer');
      return { chapterId: str(r.data['id']), ownerStatus: OWNER_STATUS[low(r.data['ownerStatus'])] ?? fallback, posted: true };
    } catch (e) {
      // The tier limit: a clean refusal, never retried and never looked up again (nothing was made).
      if (e instanceof CrowdedApiError && e.status === 429) return fail('QUOTA_EXCEEDED', 'The sub-account limit has been reached');
      // A 4xx other than 409 is a refusal: nothing was made. A transport error, a 5xx or a 409 may have followed a create.
      const unknown = e instanceof CrowdedTransportError || (e instanceof CrowdedApiError && (e.status >= 500 || e.status === 409));
      if (!unknown) throw e;
      let again: { id: string; ownerStatus?: SubAccountOwnerStatus } | undefined;
      try {
        again = await this.findByName(name, v.partyId, identity);
      } catch (second) {
        throw second instanceof MemberSubAccountError && second.code === 'VALIDATION_FAILED' ? second : e;
      }
      if (!again) throw e;
      return { chapterId: again.id, ownerStatus: again.ownerStatus ?? fallback, posted: true };
    }
  }

  /**
   * The sub-account of the nonprofit named `name` that is this identity's or nobody's: `GET /chapters?search=` lists sub-accounts as
   * chapters, so an exact name is matched and then its parent checked (the list item's `masterChapterId` or `parentChapterId`, else
   * `GET /chapters/{id}`); a same-named chapter of another parent, or one whose parent cannot be told, is not ours.
   */
  private async findByName(name: string, partyId: string, identity: string): Promise<{ id: string; ownerStatus?: SubAccountOwnerStatus } | undefined> {
    for await (const item of this.c.list('/chapters', { search: name })) {
      if (!isRecord(item) || item['name'] !== name) continue;
      const id = str(item['id']);
      const info = await this.chapterInfo(item, id);
      if (info?.parent !== this.parent) continue;
      const claim = (await this.ledger.get(`msub:claim:${this.parent}:${id}`))?.result as Claim | undefined;
      if (claim && claim.identity !== identity) {
        if (claim.party !== partyId) return fail('VALIDATION_FAILED', 'That sub-account already belongs to another request');
        continue; // another purpose of the same member
      }
      return { id, ...(info.ownerStatus ? { ownerStatus: info.ownerStatus } : {}) };
    }
    return undefined;
  }

  private async chapterInfo(listed: Record<string, unknown>, id: string): Promise<{ parent?: string; ownerStatus?: SubAccountOwnerStatus } | undefined> {
    const read = (o: Record<string, unknown>) => {
      const p = o['masterChapterId'] ?? o['parentChapterId'];
      const s = OWNER_STATUS[low(o['ownerStatus'])];
      return { ...(typeof p === 'string' || typeof p === 'number' ? { parent: String(p) } : {}), ...(s ? { ownerStatus: s } : {}) };
    };
    const fromList = read(listed);
    if (fromList.parent !== undefined) return fromList;
    try {
      const r = await this.c.get(`/chapters/${id}`);
      return isRecord(r.data) ? read(r.data) : undefined;
    } catch (e) {
      if (e instanceof CrowdedApiError && e.isMissing) return undefined;
      throw e;
    }
  }

  // ---- reads --------------------------------------------------------------------------------------------------

  /** The chapter's deposit account (the checking product, whatever its status). Only the fields named here are read: never the account or routing number. */
  private async deposit(chapterId: string): Promise<{ id: string; status: MemberSubAccountStatus; balance: Money; hold: Money }> {
    for await (const a of this.c.list(`/chapters/${chapterId}/accounts`)) {
      if (!isRecord(a) || low(a['product']) !== 'checking') continue;
      const status = STATUS[low(a['status'])];
      if (!status) return fail('PROVIDER_UNAVAILABLE', 'The sub-account provider sent an account status we do not know');
      return { id: str(a['id']), status, balance: fromCents(a['balance'], a['currency']), hold: fromCents(a['hold'] ?? 0, a['currency']) };
    }
    return fail('PROVIDER_UNAVAILABLE', 'The sub-account has no deposit account');
  }

  async subAccount(ref: string): Promise<MemberSubAccountView> {
    const parsed = parseSubAccountRef(ref);
    if (!parsed || parsed.accountId !== undefined) return fail('UNKNOWN_ACCOUNT', 'Unknown sub-account');
    return this.call(
      async () => {
        // Only a chapter under the nonprofit is a sub-account of ours: the nonprofit itself or any other chapter is not.
        const r = await this.c.get(`/chapters/${parsed.chapterId}`);
        const p = isRecord(r.data) ? (r.data['masterChapterId'] ?? r.data['parentChapterId']) : undefined;
        if (String(p) !== this.parent) return fail('UNKNOWN_ACCOUNT', 'Unknown sub-account');
        const d = await this.deposit(parsed.chapterId);
        return { status: d.status, balance: d.balance, hold: d.hold, available: USD(d.balance.minor - d.hold.minor) };
      },
      { missing: 'UNKNOWN_ACCOUNT' },
    );
  }
}

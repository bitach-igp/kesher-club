// CrowdedMemberAccounts (T-0699, REQ-INS-022, ADR-018 A1/A2): FundingAccountPort over Crowded's REST API. A member is a
// contact plus a `wallet` account in the platform chapter. Flag: none of its own (the registry wiring is T-0709).
//
// How the port's promises are kept on an API that gives less:
// - A contact create takes no idempotency key and no external id, so identity at Crowded is the MOBILE. Before a create the
//   adapter looks the contact up (`GET /contacts?search=<mobile>`, matched on the exact mobile) and adopts what it finds (a
//   create whose answer was lost). Our own records (the KeyLedger) say which PARTY a mobile belongs to: a different party
//   asking for it is DUPLICATE_MOBILE with no request sent. If the ledger is lost, a contact found by mobile is adopted
//   whoever it was made for: the vendor holds no party, so that case cannot be told apart.
// - An account create takes a body `idempotencyKey` (a UUID v4, `uuidFromKey` of the contact id, so a retry sends the same one)
//   and answers `accountCreated: false` for a contact that already has the product: both are success. A per-item `error: true`
//   (`PROVISION_FAILED`, `CONTACT_NOT_FOUND`) is PROVIDER_UNAVAILABLE: the contact exists, so it is the vendor's trouble.
// - Refs are self-describing because Crowded's contact ids and account ids are numbers in separate id spaces: `c:<id>` is a
//   contact, `a:<id>` a wallet account, `t:<id>` a transaction. `account('c:7')` is UNKNOWN_ACCOUNT with no request, so a contact
//   id is never looked up as an account id. The caller keeps the party-to-ref mapping in `ops.external_ref` (T-0698).
// - Personal data is never persisted: the KeyLedger holds only HMAC-SHA256 values under a secret `hmacKey` (a keyed hash, never a
//   bare one: a mobile has too few possibilities for an unsalted hash to hide it) and vendor ids. Never put in an error, a
//   log line or a ref: the mobile, email, name, date of birth, the account number or the routing number (never read at all).
// - Status is read from the vendor each call: Active contact and Open/Frozen/Closed account; Failed is `rejected`. No retries
//   here (a 429, a 5xx or a transport error is PROVIDER_UNAVAILABLE for the calling workflow to retry).
// Open question (not decided here): a member whose contact is `rejected` cannot re-apply with corrected data; see the card.
import { createHmac } from 'node:crypto';
import { money, type Money } from '@kesher/domain';
import {
  FundingAccountError,
  type EnsureAccountInput,
  type EnsuredAccount,
  type FundingAccountErrorCode,
  type FundingAccountPort,
  type FundingAccountStatus,
  type FundingAccountView,
  type FundingChapterView,
  type FundingTransaction,
} from '@kesher/ports';
import { CrowdedApiError, type CrowdedClient } from './client.ts';
import { InMemoryKeyLedger, type KeyLedger } from './institution-banking.ts';
import { fromCents, fundingRef, isRecord, parseFundingRef, str, uuidFromKey } from './map.ts';

export interface CrowdedMemberAccountsOptions {
  client: CrowdedClient;
  /** The platform chapter's id at Crowded: where members' contacts and wallet accounts live. Required. */
  chapterId: string;
  /** A secret of at least 32 characters (from configuration; there is no default) keying every hash this adapter stores. */
  hmacKey: string;
  /** Remembers key, party and mobile bindings. In memory by default; production wires one that persists (as for the other Crowded adapters). */
  ledger?: KeyLedger;
  /** For the date-of-birth range check. */
  now?: () => Date;
}

/** A row that carries the vendor's collect payment id when it has one (the port's row has no such field, T-0698). */
export type CrowdedFundingTransaction = FundingTransaction & { collectPaymentId?: string };

interface Binding {
  contactId: string;
  accountId?: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const USD = (minor: bigint): Money => money(minor, 'USD');
const low = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
const fail = (code: FundingAccountErrorCode, message: string): never => {
  throw new FundingAccountError(code, message);
};
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function validDate(s: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // A real calendar date, from 1900 to today: Crowded's own range is not documented, so this is a sanity bound only.
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) && Number(m[1]) >= 1900 && d.getTime() <= now.getTime();
}

const ACCOUNT_STATUS: Record<string, FundingAccountStatus> = { open: 'open', frozen: 'frozen', closed: 'closed' };

export class CrowdedMemberAccounts implements FundingAccountPort {
  private readonly c: CrowdedClient;
  private readonly chapterId: string;
  private readonly key: string;
  private readonly ledger: KeyLedger;
  private readonly now: () => Date;

  constructor(opts: CrowdedMemberAccountsOptions) {
    if (typeof opts.hmacKey !== 'string' || opts.hmacKey.length < 32) throw new Error('CrowdedMemberAccounts needs an hmacKey of at least 32 characters');
    if (!/^[A-Za-z0-9_-]+$/.test(opts.chapterId ?? '')) throw new Error('CrowdedMemberAccounts needs the platform chapterId');
    this.c = opts.client;
    this.chapterId = opts.chapterId;
    this.key = opts.hmacKey;
    this.ledger = opts.ledger ?? new InMemoryKeyLedger();
    this.now = opts.now ?? (() => new Date());
  }

  // ---- plumbing -----------------------------------------------------------------------------------------------

  /** Keyed hash, domain-separated by `scope`. */
  private mac(scope: string, ...parts: string[]): string {
    return createHmac('sha256', this.key).update(JSON.stringify([scope, ...parts])).digest('hex');
  }

  /**
   * Maps every failure to the port's closed set with fixed text (Crowded's own message can echo what we sent). `missing` is the
   * code for a 404; `refusal` maps a 400 or 422 to VALIDATION_FAILED (only a create has input the vendor can refuse).
   */
  private async call<T>(fn: () => Promise<T>, opts: { missing?: FundingAccountErrorCode; refusal?: boolean } = {}): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FundingAccountError) throw e;
      if (e instanceof CrowdedApiError) {
        if (e.isMissing && opts.missing) throw new FundingAccountError(opts.missing, 'Unknown account');
        if (opts.refusal && (e.status === 400 || e.status === 422)) throw new FundingAccountError('VALIDATION_FAILED', 'The funding provider refused the member details');
      }
      // Transport, auth, 429, 5xx, a malformed answer and anything unforeseen all fail secure.
      throw new FundingAccountError('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
    }
  }

  private path(rest: string): string {
    return `/chapters/${this.chapterId}/${rest}`;
  }

  // ---- ensureAccount ------------------------------------------------------------------------------------------

  async ensureAccount(input: EnsureAccountInput, idempotencyKey: string): Promise<EnsuredAccount> {
    const v = this.validate(input, idempotencyKey);
    const dataMac = this.mac('data', v.firstName, v.lastName, v.email, v.mobile, v.dateOfBirth ?? '');
    const inputMac = this.mac('input', v.partyId, dataMac);
    const keyK = `member:key:${idempotencyKey}`;
    const partyK = `member:party:${v.partyId}`;
    const mobileK = `member:mobile:${this.mac('mobile', v.mobile)}`;

    const bound = await this.ledger.get(keyK);
    if (bound && bound.body !== inputMac) return fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used with different input');
    let party = await this.ledger.get(partyK);
    if (!bound && party && party.body !== dataMac) return fail('PARTY_CONFLICT', 'The party already has a contact with different details');

    let binding = party?.result as Binding | undefined;
    if (!binding) {
      const owner = await this.ledger.get(mobileK);
      if (owner && owner.result !== v.partyId) return fail('DUPLICATE_MOBILE', 'The mobile number belongs to another contact');
      const contactId = await this.call(() => this.findOrCreateContact(v), { refusal: true });
      binding = { contactId };
      party = { body: dataMac, result: binding };
      await this.ledger.put(partyK, party);
      await this.ledger.put(mobileK, { body: '', result: v.partyId });
    }

    const result = await this.call(() => this.resolve(binding!, partyK, dataMac));
    if (!bound) await this.ledger.put(keyK, { body: inputMac, result: null });
    return result;
  }

  private validate(input: EnsureAccountInput, key: string): Required<Omit<EnsureAccountInput, 'dateOfBirth'>> & { dateOfBirth?: string } {
    const i = input as Partial<Record<keyof EnsureAccountInput, unknown>>;
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) return fail('VALIDATION_FAILED', 'The idempotency key must be 8 to 128 characters');
    if (!text(i.partyId)) return fail('VALIDATION_FAILED', 'partyId is required');
    if (!text(i.firstName) || !text(i.lastName)) return fail('VALIDATION_FAILED', 'A first and last name are required');
    if (typeof i.email !== 'string' || !EMAIL.test(i.email)) return fail('VALIDATION_FAILED', 'email is not valid');
    if (typeof i.mobile !== 'string' || !E164.test(i.mobile)) return fail('VALIDATION_FAILED', 'mobile must be E.164');
    if (i.dateOfBirth !== undefined && (typeof i.dateOfBirth !== 'string' || !validDate(i.dateOfBirth, this.now()))) return fail('VALIDATION_FAILED', 'dateOfBirth must be a past YYYY-MM-DD date');
    return {
      partyId: i.partyId,
      firstName: i.firstName.trim(),
      lastName: i.lastName.trim(),
      email: i.email.toLowerCase(),
      mobile: i.mobile,
      ...(i.dateOfBirth !== undefined ? { dateOfBirth: i.dateOfBirth } : {}),
    };
  }

  /** The contact for this mobile: one the vendor already holds, else a new one. Returns its id. */
  private async findOrCreateContact(v: { firstName: string; lastName: string; email: string; mobile: string; dateOfBirth?: string }): Promise<string> {
    const found = await this.findContact(v.mobile);
    if (found) return found;
    const r = await this.c.post(this.path('contacts'), [{ firstName: v.firstName, lastName: v.lastName, mobile: v.mobile, email: v.email, ...(v.dateOfBirth ? { dateOfBirth: v.dateOfBirth } : {}) }]);
    const entry = Array.isArray(r.data) ? r.data[0] : undefined;
    if (isRecord(entry) && entry['id'] !== undefined && entry['id'] !== null) return str(entry['id']);
    // A Failed entry with no id is the vendor's duplicate-mobile answer (a create that raced ours): adopt the one it holds.
    return (await this.findContact(v.mobile)) ?? fail('PROVIDER_UNAVAILABLE', 'The funding provider did not create the contact');
  }

  private async findContact(mobile: string): Promise<string | undefined> {
    for await (const item of this.c.list(this.path('contacts'), { search: mobile })) {
      if (isRecord(item) && item['mobile'] === mobile) return str(item['id']);
    }
    return undefined;
  }

  /** The contact's and account's current state, creating the wallet account when there is none yet. */
  private async resolve(binding: Binding, partyK: string, dataMac: string): Promise<EnsuredAccount> {
    const contactRef = fundingRef('c', binding.contactId);
    const contact = await this.c.get(this.path(`contacts/${binding.contactId}`));
    if (!isRecord(contact.data)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable contact');
    const status = low(contact.data['status']);
    if (status === 'failed') return { contactRef, status: 'rejected' };
    if (status === 'archived') return { contactRef, status: 'archived' };
    if (status !== 'active') return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent a contact status we do not know');

    let accountId = binding.accountId;
    if (!accountId) {
      accountId = await this.createAccount(binding.contactId);
      binding.accountId = accountId;
      await this.ledger.put(partyK, { body: dataMac, result: binding });
    }
    const view = await this.readAccount(accountId);
    return { contactRef, accountRef: fundingRef('a', accountId), status: view.status };
  }

  private async createAccount(contactId: string): Promise<string> {
    const r = await this.c.post(this.path('accounts'), { items: [{ contactId, product: 'wallet', withDigitalCard: false }], idempotencyKey: uuidFromKey(`funding-wallet:${contactId}`) });
    const res = isRecord(r.data) && Array.isArray(r.data['results']) ? r.data['results'][0] : undefined;
    if (!isRecord(res) || res['error'] === true) return fail('PROVIDER_UNAVAILABLE', 'The funding provider could not provision the account');
    if (res['accountId'] !== undefined && res['accountId'] !== null) return str(res['accountId']);
    // `accountCreated: false` should carry the existing account's id; if it does not, find it by its contact.
    for await (const a of this.c.list(this.path('accounts'))) {
      if (isRecord(a) && a['product'] === 'wallet' && String(a['contactId']) === contactId) return str(a['id']);
    }
    return fail('PROVIDER_UNAVAILABLE', 'The funding provider did not say which account it made');
  }

  // ---- reads --------------------------------------------------------------------------------------------------

  /** A wallet account of this chapter: anything else (another product, another chapter's id, a missing one) is UNKNOWN_ACCOUNT. */
  private async readAccount(id: string): Promise<FundingAccountView> {
    const r = await this.c.get(this.path(`accounts/${id}`));
    const a = r.data;
    if (!isRecord(a)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable account');
    if (low(a['product']) !== 'wallet') return fail('UNKNOWN_ACCOUNT', 'Unknown account');
    const status = ACCOUNT_STATUS[low(a['status'])];
    if (!status) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an account status we do not know');
    const balance = fromCents(a['balance'], a['currency']);
    const hold = fromCents(a['hold'] ?? 0, a['currency']);
    return { status, balance, hold, available: USD(balance.minor - hold.minor) };
  }

  async account(accountRef: string): Promise<FundingAccountView> {
    const id = parseFundingRef('a', accountRef);
    if (!id) return fail('UNKNOWN_ACCOUNT', 'Unknown account');
    return this.call(() => this.readAccount(id), { missing: 'UNKNOWN_ACCOUNT' });
  }

  async chapter(): Promise<FundingChapterView> {
    return this.call(async () => {
      for await (const a of this.c.list(this.path('accounts'))) {
        if (isRecord(a) && low(a['product']) === 'checking' && low(a['status']) === 'open') return { checking: fromCents(a['balance'], a['currency']) };
      }
      return fail('PROVIDER_UNAVAILABLE', 'The platform chapter has no open checking account');
    });
  }

  async *transactions(input: { accountRef: string; from: string; to: string }): AsyncGenerator<CrowdedFundingTransaction> {
    const id = parseFundingRef('a', input.accountRef);
    if (!id) return fail('UNKNOWN_ACCOUNT', 'Unknown account');
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (Number.isNaN(from) || Number.isNaN(to)) return fail('VALIDATION_FAILED', 'from and to must be ISO instants');
    await this.call(() => this.readAccount(id), { missing: 'UNKNOWN_ACCOUNT' });
    const seen = new Set<string>();
    const rows = this.c.list(this.path(`accounts/${id}/transactions`), { 'filter[createdAt][min]': new Date(from).toISOString(), 'filter[createdAt][max]': new Date(to).toISOString() });
    for (;;) {
      const next = await this.call(() => rows.next());
      if (next.done) return;
      const t = await this.call(async () => this.toTransaction(next.value)); // a pure mapping, wrapped for the error set
      const at = Date.parse(t.postedAt);
      // The vendor's max is inclusive and our `to` is not; its min we repeat, as a guard.
      if (at < from || at >= to || seen.has(t.transactionRef)) continue;
      seen.add(t.transactionRef);
      yield t;
    }
  }

  private toTransaction(row: unknown): CrowdedFundingTransaction {
    if (!isRecord(row)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable transaction');
    const direction = low(row['direction']);
    if (direction !== 'credit' && direction !== 'debit') return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent a transaction direction we do not know');
    const amount = fromCents(row['amount']);
    const created = typeof row['createdAt'] === 'string' ? new Date(row['createdAt']) : undefined;
    if (amount.minor <= 0n || !created || Number.isNaN(created.getTime())) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent a transaction we cannot read');
    const cp = row['collectPaymentId'];
    return {
      transactionRef: fundingRef('t', str(row['id'])),
      kind: direction,
      amount,
      postedAt: created.toISOString(),
      // The vendor's text: untrusted, passed through as data only.
      description: typeof row['title'] === 'string' ? row['title'] : '',
      ...(cp !== undefined && cp !== null && cp !== '' ? { collectPaymentId: str(cp) } : {}),
    };
  }
}

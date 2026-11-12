// FakeCrowded (T-0648): an in-memory Crowded REST API for the adapter's contract suite and tests. Its `fetch` runs the
// client in-process: bearer auth, the `data` envelope, `pagination[limit|offset]` with `meta.pagination.total`, the
// documented status vocabularies and errors, and the quirks the adapter must survive: an unmasked `accountNumber`,
// creates with no idempotency key, a 201 whose status is Rejected, a payment intent that is an upsert. Control methods
// stand in for what happens outside the API (the bank decides, a funder pays, a transfer moves on).
// Fixtures: an organization named `OUTAGE…` answers 503; a counterpartyId starting `ach_rejected_201` answers 201 Rejected;
// `inFlightAchCalls = n` makes the next n ACH creates answer 409 DUPLICATE_REQUEST (in flight).
// Sub-accounts answer the live sandbox's shape (2026-11-10, T-0696): a repeat of the same idempotencyKey answers 500, never
// the first sub-account; `subAccountQuota = n` makes a create past n sub-accounts answer 429, checked before the key; the
// chapter list finds sub-accounts by `search` and never says whose they are, `GET /chapters/{id}` carries the parent as
// `masterChapterId` (checked against the live sandbox 2026-11-11), and only the create response has `parentChapterId`.
// Member contacts and wallet accounts (T-0699): contact ids and wallet account ids are NUMBERS from two separate counters, so the
// contact 1 and the account 1 exist side by side (an adapter that confuses the two id spaces is caught). A contact create has no
// idempotency key; a duplicate mobile in the chapter is a Failed entry with no id; the fixture emails `rejected@example.test`
// (an entry created Failed, with an id), `frozen@example.test` (a Frozen account) and `outage@example.test` (the whole request
// answers 503) stand in for the bank's decisions. An account create is a bulk call with a body `idempotencyKey`, and a contact
// that already has the product answers `accountCreated: false`. Wallet accounts show an unmasked account number, as the real list does.
import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;
interface Chapter { id: string; name: string; organizationId: string; parent?: string; application?: 'FormInProgress' | 'Approved' | 'Denied' | 'AwaitingDocuments' }
interface Account { id: string; chapterId: string; accountNumber: string; balance: bigint }
interface Contact { id: number; chapterId: string; firstName: string; lastName: string; mobile: string; email: string; dateOfBirth: string | null; status: 'Active' | 'Failed' | 'Archived'; createdAt: Date }
interface Wallet { id: number; chapterId: string; contactId: number; status: 'Open' | 'Frozen' | 'Closed'; accountNumber: string; balance: bigint; hold: bigint; createdAt: Date }
/** A payment on a hosted-collection intent (T-0700). `amount` is gross: the net plus the fee when the payer covered it. */
interface IntentPayment { id: string; method: 'Card' | 'Ach'; status: 'Pending' | 'Processing' | 'Succeeded' | 'Failed' | 'Returned' | 'Refunded' | 'Cancelled'; amount: bigint; fee: bigint; feeCovered: boolean; createdAt: Date; updatedAt: Date }
interface Intent { id: string; chapterId: string; collectionId: string; email: string; contactId?: number; amount: bigint; paid?: { id: string; at: Date }; payments: IntentPayment[]; successUrl?: string; failureUrl?: string; payerIp?: string }
interface Payment { id: string; chapterId: string; method: 'ach'; status: 'pending' | 'processing' | 'sent' | 'returned' | 'canceled' | 'failed'; amount: bigint; counterpartyId: string; addenda: string; key: string; body: string }

export interface FakeCrowdedOptions {
  token: string;
  /** The provider's page size cap, so lists cross page boundaries in tests. */
  pageSize?: number;
  now?: () => Date;
}

/** Crowded's JSON carries cents as numbers; the fake keeps bigint and converts only here. */
const wire = (m: bigint): number => Number(m);
const cents = (v: unknown): bigint => BigInt(Number(v));
const ok = (data: unknown, status = 200, meta?: Json): Response => new Response(JSON.stringify({ data, ...(meta ? { meta } : {}) }), { status, headers: { 'content-type': 'application/json' } });
/** The live API's rule (sandbox, 2026-11-11, T-0734): a body `idempotencyKey` is a strict UUID v4; a version-5 key is a 400. */
const V4_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isV4Key = (key: unknown): key is string => typeof key === 'string' && V4_KEY.test(key);
const V4_MESSAGE = 'Idempotency key must be a valid UUID v4';
const err = (status: number, message: string, code?: string, type?: string): Response => new Response(JSON.stringify({ type: type ?? (status === 400 ? 'ResourceInputError' : 'Error'), statusCode: status, message, ...(code ? { code } : {}), requestId: 'req_fake' }), { status, headers: { 'content-type': 'application/json' } });

export class FakeCrowded {
  readonly fetch: typeof globalThis.fetch;
  /** Every request the client made: method, path, query and body (for assertions). The token is never recorded. */
  readonly calls: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
  /** The next N requests answer 503. */
  outageRequests = 0;
  readonly secret = 'sha256=fake';

  private readonly token: string;
  private readonly pageSize: number;
  private readonly now: () => Date;
  private n = 0;
  private readonly orgs: { id: string; name: string }[] = [];
  private readonly chapters: Chapter[] = [];
  private readonly accounts: Account[] = [];
  private readonly collections: { id: string; chapterId: string; title: string; requestedAmount: bigint }[] = [];
  private readonly intents: Intent[] = [];
  private readonly payments: Payment[] = [];
  private readonly ledger: { id: string; chapterId: string; accountId: string; direction: 'Credit' | 'Debit'; amount: bigint; title: string; at: Date; collectPaymentId?: string }[] = [];
  private readonly contacts: Contact[] = [];
  private readonly wallets: Wallet[] = [];
  private contactSeq = 0;
  private walletSeq = 0;
  private readonly keys = new Map<string, { body: string; response: Response }>();
  private readonly funded = new Map<string, Json>();
  private readonly subKeys = new Set<string>();
  /** A fee on collected payments, and whether the payer covered it (so the fee item is `amount - fee`). */
  collectFee: { fee: bigint; covered: boolean } = { fee: 0n, covered: false };
  /**
   * The next N ACH creates answer 409 DUPLICATE_REQUEST, as when another request with the same key is in flight (T-0695).
   * The first of them is that other request: it makes the payment (once per key), and the call after the N answers the
   * original payment, as Crowded documents.
   */
  inFlightAchCalls = 0;
  /** The next N intent creates answer 503 before anything is made (a collection made just before stays). */
  failIntents = 0;
  /** The host the hosted payment pages are on; a test sets another scheme to see a bad page refused. */
  paymentUrlBase = 'https://pay.fake.invalid';
  /** Quotes carry no fee (a malformed quote). */
  quoteWithoutFee = false;
  /** Sub-accounts the tenant may hold; a create past it answers 429 SubscriptionQuotaExceededError (before the key is looked at). */
  subAccountQuota: number | undefined = undefined;
  /** The next wallet account creates answer a per-item `error: true` with this code (a 200, as the bulk call does). */
  accountProvisionError: 'PROVISION_FAILED' | 'CONTACT_NOT_FOUND' | undefined = undefined;

  constructor(opts: FakeCrowdedOptions) {
    this.token = opts.token;
    this.pageSize = opts.pageSize ?? 100;
    this.now = opts.now ?? (() => new Date('2026-11-03T09:00:00Z'));
    this.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method ?? 'GET';
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const path = url.pathname.replace(/^.*\/api\/v1/, '');
      this.calls.push({ method, path, query, body });
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== `Bearer ${this.token}`) return err(401, 'Unauthorized');
      if (this.outageRequests > 0) {
        this.outageRequests--;
        return err(503, 'Unavailable');
      }
      return this.route(method, path, query, (body as Json | undefined)?.['data']);
    };
  }

  private id(prefix: string): string {
    return `${prefix}${String(++this.n).padStart(6, '0')}`;
  }

  // ---- control hooks (what happens outside the API) -------------------------------------------------------------

  /** The bank approves the chapter's application and opens its deposit account. */
  decide(chapterId: string, outcome: 'Approved' | 'Denied' | 'AwaitingDocuments' = 'Approved'): void {
    const c = this.chapter(chapterId);
    c.application = outcome;
    if (outcome === 'Approved') this.openAccount(chapterId);
  }
  fund(chapterId: string, minor: bigint): void {
    this.credit(this.accountOf(chapterId), minor, 'Wire in');
  }
  post(chapterId: string, count: number): void {
    for (let i = 0; i < count; i++) this.credit(this.accountOf(chapterId), 100n + BigInt(i), `Deposit ${i}`);
  }
  /** A funder pays an intent; answers the signed webhook batch for it. `intentRef` is `<chapter>:<collection>:<intent>`. */
  pay(intentRef: string): { headers: Record<string, string>; rawBody: string } {
    const [chapterId, , intentId] = intentRef.split(':');
    const i = this.intents.find((x) => x.chapterId === chapterId && x.id === intentId);
    if (!i) throw new Error('unknown intent');
    i.paid = { id: this.id('cp'), at: this.now() };
    this.credit(this.accountOf(i.chapterId), i.amount, `Collected ${i.paid.id}`);
    return this.webhook([{ eventType: 'collect.payment.succeeded', data: { id: i.paid.id }, chapterId: i.chapterId }]);
  }

  // ---- hosted collection payments (T-0700): the payment lifecycle is fake-only, the sandbox cannot drive it ----------------

  /** The payer pays an intent on the hosted page: a card succeeds at once, a bank transfer starts Pending. Returns the payment id. `amount` overrides the gross (a net that does not fit). */
  payIntent(intentRef: string, method: 'card' | 'ach', over: { amount?: bigint } = {}): string {
    const i = this.intentOf(intentRef);
    const at = this.now();
    const fee = this.collectFee.fee;
    const p: IntentPayment = { id: this.id('cp'), method: method === 'card' ? 'Card' : 'Ach', status: method === 'card' ? 'Succeeded' : 'Pending', amount: over.amount ?? i.amount + (this.collectFee.covered ? fee : 0n), fee, feeCovered: this.collectFee.covered, createdAt: at, updatedAt: at };
    i.payments.push(p);
    return p.id;
  }
  /** A bank transfer moves to Processing. */
  process(paymentId: string): void {
    this.move(paymentId, ['Pending'], 'Processing');
  }
  /** A bank transfer settles: Succeeded, stamped now. */
  settle(paymentId: string): void {
    this.move(paymentId, ['Pending', 'Processing'], 'Succeeded');
  }
  fail(paymentId: string): void {
    this.move(paymentId, ['Pending', 'Processing'], 'Failed');
  }
  /** The bank returns a settled transfer, after it showed Succeeded. */
  returnPayment(paymentId: string): void {
    this.move(paymentId, ['Succeeded'], 'Returned');
  }
  cancel(paymentId: string): void {
    this.move(paymentId, ['Pending', 'Processing'], 'Cancelled');
  }
  /** A card payment is refunded. */
  refundCard(paymentId: string): void {
    const p = this.paymentOf(paymentId);
    if (p.method !== 'Card') throw new Error('only a card can be refunded');
    this.move(paymentId, ['Succeeded'], 'Refunded');
  }
  private paymentOf(id: string): IntentPayment {
    const p = this.intents.flatMap((i) => i.payments).find((x) => x.id === id);
    if (!p) throw new Error('unknown payment');
    return p;
  }
  private move(id: string, from: IntentPayment['status'][], to: IntentPayment['status']): void {
    const p = this.paymentOf(id);
    if (!from.includes(p.status)) throw new Error(`a ${p.status} payment cannot become ${to}`);
    p.status = to;
    p.updatedAt = this.now();
  }
  private intentOf(intentRef: string): Intent {
    const [chapterId, , intentId] = intentRef.split(':');
    const i = this.intents.find((x) => x.chapterId === chapterId && x.id === intentId);
    if (!i) throw new Error('unknown intent');
    return i;
  }
  /** What the intent was created with: the contact, the payer's address and the redirect urls as sent (for assertions). */
  intentRequest(intentId: string): { contactId: number | undefined; payerIp: string | undefined; successUrl: string | undefined; failureUrl: string | undefined } {
    const i = this.intents.find((x) => x.id === intentId);
    if (!i) throw new Error('unknown intent');
    return { contactId: i.contactId, payerIp: i.payerIp, successUrl: i.successUrl, failureUrl: i.failureUrl };
  }
  private intentJson(i: Intent): Json {
    const live = i.payments;
    const status = live.some((p) => p.status === 'Succeeded') || i.paid ? 'Paid' : live.some((p) => p.status === 'Pending' || p.status === 'Processing') ? 'Pending' : live.at(-1)?.status === 'Returned' ? 'Returned' : live.at(-1)?.status === 'Cancelled' ? 'Cancelled' : live.length === 0 ? 'Pending' : 'Not Paid';
    return {
      id: i.id,
      requestedAmount: wire(i.amount),
      status,
      paymentUrl: `${this.paymentUrlBase}/${i.id}`,
      ...(i.contactId === undefined ? {} : { contactId: i.contactId }),
      ...(i.successUrl ? { successUrl: i.successUrl } : {}),
      ...(i.failureUrl ? { failureUrl: i.failureUrl } : {}),
      payments: live.map((p) => ({ id: p.id, uid: p.id, method: p.method, amount: wire(p.amount), fee: wire(p.fee), feeCovered: p.feeCovered, status: p.status, incompleteReason: null, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() })),
    };
  }

  /** pending -> processing -> sent. */
  advanceAch(paymentRef: string): void {
    const p = this.payments.find((x) => `${x.chapterId}:${x.id}` === paymentRef);
    if (!p) throw new Error('unknown payment');
    p.status = p.status === 'pending' ? 'processing' : 'sent';
  }
  webhook(events: { eventType: string; data?: Json; chapterId?: string }[], signature = this.secret): { headers: Record<string, string>; rawBody: string } {
    const batch = { batchId: this.id('b'), count: events.length, events: events.map((e) => ({ eventId: this.id('ev'), eventType: e.eventType, version: '1.0', timestamp: this.now().toISOString(), context: { partnerId: 'p1', ...(e.chapterId ? { chapterId: e.chapterId } : {}) }, data: e.data ?? {} })) };
    return { headers: { 'x-webhook-signature': signature }, rawBody: JSON.stringify(batch) };
  }
  /** The full account number, for tests that check it never leaves the adapter. */
  accountNumber(chapterId: string): string {
    return this.accountOf(chapterId).accountNumber;
  }
  count(kind: 'organizations' | 'chapters' | 'collections' | 'payments' | 'contacts' | 'accounts' | 'intents'): number {
    if (kind === 'accounts') return this.wallets.length; // wallet accounts; a chapter's checking account is not counted
    if (kind === 'intents') return this.intents.length;
    return this[kind === 'organizations' ? 'orgs' : kind].length;
  }

  // ---- member contacts and wallet accounts (T-0699) -------------------------------------------------------------

  /** An approved chapter with its checking account, for a test that needs a platform chapter at once. */
  seedChapter(name = 'Platform'): string {
    const org = { id: this.id('org'), name };
    this.orgs.push(org);
    const ch: Chapter = { id: this.id('ch'), name, organizationId: org.id };
    this.chapters.push(ch);
    this.decide(ch.id);
    return ch.id;
  }
  /** The chapter's checking balance is set to `minor` (a credit or debit row for the difference). */
  setChecking(chapterId: string, minor: bigint): void {
    const a = this.accountOf(chapterId);
    if (minor >= a.balance) this.credit(a, minor - a.balance, 'Set balance');
    else this.debit(a, a.balance - minor, 'Set balance');
  }
  /** The bank decides the contact failed (the contact keeps its mobile). */
  failContact(mobile: string): void {
    this.contactByMobile(mobile).status = 'Failed';
  }
  contactId(mobile: string): number {
    return this.contactByMobile(mobile).id;
  }
  walletId(contactId: number): number {
    const w = this.wallets.find((x) => x.contactId === contactId);
    if (!w) throw new Error('no wallet');
    return w.id;
  }
  freezeAccount(id: number): void {
    this.wallet(id).status = 'Frozen';
  }
  setAccountStatus(id: number, status: 'Open' | 'Frozen' | 'Closed'): void {
    this.wallet(id).status = status;
  }
  /** Sets the wallet balance (a credit or debit row for the difference). */
  setBalance(id: number, minor: bigint): void {
    const w = this.wallet(id);
    if (minor >= w.balance) this.postWallet(w, 'Credit', minor - w.balance, 'Set balance');
    else this.postWallet(w, 'Debit', w.balance - minor, 'Set balance');
  }
  /** A credit row, as from a released collection when `collectPaymentId` is given. */
  creditWallet(id: number, minor: bigint, extra: { title?: string; collectPaymentId?: string } = {}): void {
    this.postWallet(this.wallet(id), 'Credit', minor, extra.title ?? 'Credit', extra.collectPaymentId);
  }
  debitWallet(id: number, minor: bigint, title = 'Debit'): void {
    this.postWallet(this.wallet(id), 'Debit', minor, title);
  }
  holdWallet(id: number, minor: bigint): void {
    this.wallet(id).hold = minor;
  }
  /** The full account number of a wallet, for tests that check it never leaves the adapter. */
  walletNumber(id: number): string {
    return this.wallet(id).accountNumber;
  }
  private contactByMobile(mobile: string): Contact {
    const c = this.contacts.find((x) => x.mobile === mobile);
    if (!c) throw new Error('no such contact');
    return c;
  }
  private wallet(id: number): Wallet {
    const w = this.wallets.find((x) => x.id === id);
    if (!w) throw new Error(`no wallet ${id}`);
    return w;
  }
  private postWallet(w: Wallet, direction: 'Credit' | 'Debit', minor: bigint, title: string, collectPaymentId?: string): void {
    w.balance += direction === 'Credit' ? minor : -minor;
    this.ledger.push({ id: this.id('tx'), chapterId: w.chapterId, accountId: String(w.id), direction, amount: minor, title, at: this.now(), ...(collectPaymentId ? { collectPaymentId } : {}) });
  }
  /** Sub-accounts (chapters with a parent) created so far. */
  subAccountCount(): number {
    return this.chapters.filter((c) => c.parent).length;
  }

  /** The names (titles for collections) of what has been created, oldest first: what a lookup by name can see. */
  names(kind: 'organizations' | 'chapters' | 'collections'): string[] {
    if (kind === 'organizations') return this.orgs.map((o) => o.name);
    if (kind === 'chapters') return this.chapters.map((c) => c.name);
    return this.collections.map((c) => c.title);
  }

  // ---- state helpers --------------------------------------------------------------------------------------------

  private chapter(id: string): Chapter {
    const c = this.chapters.find((x) => x.id === id);
    if (!c) throw new Error(`no chapter ${id}`);
    return c;
  }
  private openAccount(chapterId: string): Account {
    const have = this.accounts.find((a) => a.chapterId === chapterId);
    if (have) return have;
    const a = { id: this.id('acct'), chapterId, accountNumber: `0001${String(this.n).padStart(8, '0')}`, balance: 0n };
    this.accounts.push(a);
    return a;
  }
  private accountOf(chapterId: string): Account {
    const a = this.accounts.find((x) => x.chapterId === chapterId);
    if (!a) throw new Error('no account yet');
    return a;
  }
  private credit(a: Account, minor: bigint, title: string): void {
    a.balance += minor;
    this.ledger.push({ id: this.id('tx'), chapterId: a.chapterId, accountId: a.id, direction: 'Credit', amount: minor, title, at: this.now() });
  }
  private debit(a: Account, minor: bigint, title: string): void {
    a.balance -= minor;
    this.ledger.push({ id: this.id('tx'), chapterId: a.chapterId, accountId: a.id, direction: 'Debit', amount: minor, title, at: this.now() });
  }

  private page(items: unknown[], q: Record<string, string>): Response {
    const limit = Math.min(Number(q['pagination[limit]'] ?? 10), this.pageSize);
    const offset = Number(q['pagination[offset]'] ?? 0);
    return ok(items.slice(offset, offset + limit), 200, { pagination: { total: items.length, limit, offset, sort: 'createdAt', order: 'DESC' } });
  }

  /** A create with a body `idempotencyKey`: the same body answers the same response, another body is 409. */
  private keyed(key: unknown, body: unknown, make: () => Response): Response {
    if (!isV4Key(key)) return err(400, V4_MESSAGE, undefined, 'ValidationError');
    const text = JSON.stringify(body);
    const prior = this.keys.get(key);
    if (prior) return prior.body === text ? prior.response.clone() : err(409, 'Idempotency key reused', 'DUPLICATE_REQUEST');
    const response = make();
    if (response.ok) this.keys.set(key, { body: text, response: response.clone() });
    return response;
  }

  // ---- routes ---------------------------------------------------------------------------------------------------

  private route(method: string, path: string, q: Record<string, string>, data: unknown): Response {
    const d = (data ?? {}) as Json;
    let m: RegExpMatchArray | null;

    if (method === 'POST' && path === '/organizations') {
      if (String(d['name']).startsWith('OUTAGE')) return err(503, 'Unavailable');
      const o = { id: this.id('org'), name: String(d['name']) };
      this.orgs.push(o);
      return ok({ ...o, createdAt: this.now().toISOString() }, 201);
    }
    if (method === 'GET' && path === '/organizations') return this.page(this.orgs.filter((o) => !q['search'] || o.name.includes(q['search'])), q);

    if (method === 'POST' && path === '/chapters') {
      if (!this.orgs.some((o) => o.id === d['organizationId']) || typeof d['businessVertical'] !== 'string') return err(400, 'Invalid chapter', 'VALIDATION_ERROR');
      const c: Chapter = { id: this.id('ch'), name: String(d['name']), organizationId: String(d['organizationId']) };
      this.chapters.push(c);
      return ok({ ...c, status: 'Active', ein: null }, 201);
    }
    if (method === 'GET' && path === '/chapters') {
      const rows = this.chapters.filter((c) => (!q['search'] || c.name.includes(q['search'])) && (!q['filter[organizationId]'] || c.organizationId === q['filter[organizationId]']));
      return this.page(rows.map(({ parent: _parent, ...c }) => c), q);
    }
    if (method === 'GET' && (m = path.match(/^\/chapters\/([^/]+)$/))) {
      const c = this.chapters.find((x) => x.id === m![1]);
      if (!c) return err(404, 'Chapter not found', undefined, 'NotExistError');
      const { parent, ...rest } = c;
      return ok({ ...rest, status: 'Active', isMasterSubAccount: false, isMasterSubEntity: false, ...(parent ? { masterChapterId: parent } : {}) });
    }

    if ((m = path.match(/^\/chapters\/([^/]+)\/(.*)$/))) {
      const chapter = this.chapters.find((c) => c.id === m![1]);
      if (!chapter) return err(404, 'Chapter not found');
      return this.chapterRoute(method, chapter, m[2]!, q, d, data);
    }
    if (method === 'GET' && path === '/collect-payments') {
      const min = q['filter[createdAt][min]'] ? new Date(q['filter[createdAt][min]']) : undefined;
      const rows = this.intents
        .filter((i) => i.paid && i.chapterId === q['filter[chapterId]'] && (!min || i.paid.at >= min))
        .map((i) => ({ id: i.paid!.id, method: 'Card', status: 'Succeeded', amount: wire(i.amount), fee: wire(this.collectFee.fee), feeCovered: this.collectFee.covered, createdAt: i.paid!.at.toISOString(), updatedAt: i.paid!.at.toISOString(), collectRequest: { id: i.collectionId }, intent: { id: i.id } }));
      return this.page(rows, q);
    }
    return err(404, 'No such route');
  }

  private chapterRoute(method: string, ch: Chapter, rest: string, q: Record<string, string>, d: Json, data: unknown): Response {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && rest === 'applications/form') {
      if (!/^[0-9a-f.:]{3,45}$/i.test(String(d['contactIp']))) return err(400, 'contactIp required', 'VALIDATION_ERROR');
      ch.application ??= 'FormInProgress';
      return ok({ status: 'EnterBusinessInformation', url: `https://apply.fake.invalid/${ch.id}` }, 201);
    }
    if (method === 'GET' && rest === 'applications') return ch.application ? ok({ status: ch.application === 'FormInProgress' ? 'FormInProgress' : ch.application }) : err(400, 'No application', 'VALIDATION_ERROR');
    if (method === 'GET' && rest === 'accounts') {
      const a = ch.application === 'Approved' || ch.parent ? this.accounts.filter((x) => x.chapterId === ch.id) : [];
      const checking = a.map((x) => ({ id: x.id, name: 'Checking', status: 'Open', accountNumber: x.accountNumber, routingNumber: '084106768', currency: 'USD', balance: wire(x.balance), hold: wire(0n), available: wire(x.balance), product: 'checking' }));
      return this.page([...checking, ...this.wallets.filter((w) => w.chapterId === ch.id).map((w) => this.walletJson(w))], q);
    }
    if (method === 'POST' && rest === 'contacts') return this.createContacts(ch, data);
    if (method === 'GET' && rest === 'contacts') {
      const s = (q['search'] ?? '').toLowerCase();
      const rows = this.contacts.filter((c) => c.chapterId === ch.id && (!s || [c.firstName, c.lastName, c.email, c.mobile].some((f) => f.toLowerCase().includes(s))));
      return this.page(rows.map((c) => this.contactJson(c)), q);
    }
    if ((m = rest.match(/^contacts\/([^/]+)$/)) && method === 'GET') {
      const c = this.contacts.find((x) => x.chapterId === ch.id && String(x.id) === m![1]);
      return c ? ok(this.contactJson(c)) : err(404, 'Contact not found', undefined, 'NotExistError');
    }
    if (method === 'POST' && rest === 'accounts') return this.createAccounts(ch, d);
    if ((m = rest.match(/^accounts\/([^/]+)$/)) && method === 'GET') {
      const w = this.wallets.find((x) => x.chapterId === ch.id && String(x.id) === m![1]);
      if (w) return ok(this.walletJson(w));
      const c = this.accounts.find((x) => x.chapterId === ch.id && x.id === m![1]);
      return c ? ok({ id: c.id, name: 'Checking', status: 'Open', accountNumber: c.accountNumber, routingNumber: '084106768', currency: 'USD', balance: wire(c.balance), hold: wire(0n), available: wire(c.balance), product: 'checking' }) : err(404, 'Account not found', undefined, 'NotExistError');
    }
    if ((m = rest.match(/^accounts\/([^/]+)\/transactions$/)) && method === 'GET') {
      const accountId = m[1]!;
      if (!this.wallets.some((x) => x.chapterId === ch.id && String(x.id) === accountId) && !this.accounts.some((x) => x.chapterId === ch.id && x.id === accountId)) return err(404, 'Account not found', undefined, 'NotExistError');
      const min = q['filter[createdAt][min]'] ? new Date(q['filter[createdAt][min]']) : undefined;
      const max = q['filter[createdAt][max]'] ? new Date(q['filter[createdAt][max]']) : undefined;
      const rows = this.ledger
        .filter((t) => t.chapterId === ch.id && t.accountId === accountId && (!min || t.at >= min) && (!max || t.at <= max))
        .map((t) => ({ id: t.id, accountId: t.accountId, type: 'bookTransaction', direction: t.direction, amount: wire(t.amount), title: t.title, createdAt: t.at.toISOString(), ...(t.collectPaymentId ? { collectPaymentId: t.collectPaymentId } : {}) }));
      return this.page(rows, q);
    }
    if (method === 'POST' && rest === 'subaccounts') {
      if (ch.application !== 'Approved') return err(400, 'Parent has no account', 'VALIDATION_ERROR');
      if (!d['email'] && !d['owner']) return err(400, 'owner or email required', 'VALIDATION_ERROR');
      // The live shape (2026-11-10): the quota is checked before the key; a key seen before answers 500, whatever the body.
      if (this.subAccountQuota !== undefined && this.subAccountCount() >= this.subAccountQuota) return err(429, 'Limit has already been reached', undefined, 'SubscriptionQuotaExceededError');
      const key = String(d['idempotencyKey']);
      if (!isV4Key(key)) return err(400, V4_MESSAGE, undefined, 'ValidationError');
      if (this.subKeys.has(key)) return err(500, 'Internal server error', undefined, 'InternalServerErrorException');
      this.subKeys.add(key);
      const sub: Chapter = { id: this.id('ch'), name: String(d['name']), organizationId: ch.organizationId, parent: ch.id };
      this.chapters.push(sub);
      this.openAccount(sub.id);
      return ok({ id: sub.id, name: sub.name, parentChapterId: ch.id, status: 'Active', createdAt: this.now().toISOString() }, 201);
    }
    if (method === 'POST' && rest === 'subaccounts/fund') {
      const items = Array.isArray(data) ? (data as Json[]) : [];
      const results = items.map((it) => {
        if (!isV4Key(it['idempotencyKey'])) return { id: it['id'], status: 'failed', error: V4_MESSAGE };
        const seen = this.funded.get(String(it['idempotencyKey']));
        if (seen) return seen;
        const sub = this.chapters.find((c) => c.id === it['id'] && c.parent === ch.id);
        const from = this.accounts.find((a) => a.chapterId === ch.id);
        const moved = cents(it['amount']);
        if (!sub || !from || !(moved > 0n)) return { id: it['id'], status: 'failed', error: 'Invalid subaccount or amount' };
        if (from.balance < moved) return { id: it['id'], status: 'failed', error: 'Insufficient funds' };
        this.debit(from, moved, `Fund ${sub.id}`);
        this.credit(this.accountOf(sub.id), moved, `Funded by ${ch.id}`);
        const done = { id: sub.id, status: 'success' };
        this.funded.set(String(it['idempotencyKey']), done);
        return done;
      });
      return ok(results);
    }
    if (method === 'POST' && rest === 'collections') {
      const requested = cents(d['requestedAmount']);
      if (!String(d['title'] ?? '') || String(d['title']).length > 50 || !(requested >= 100n)) return err(400, 'Invalid collection', 'VALIDATION_ERROR');
      const c = { id: this.id('col'), chapterId: ch.id, title: String(d['title']), requestedAmount: requested };
      this.collections.push(c);
      return ok({ ...c, requestedAmount: wire(c.requestedAmount), createdAt: this.now().toISOString() }, 201);
    }
    if (method === 'GET' && rest === 'collections') return this.page(this.collections.filter((c) => c.chapterId === ch.id && (!q['search'] || c.title.includes(q['search']))).map((c) => ({ ...c, requestedAmount: wire(c.requestedAmount) })), q);
    if ((m = rest.match(/^collections\/([^/]+)$/)) && method === 'GET') {
      const c = this.collections.find((x) => x.chapterId === ch.id && x.id === m![1]);
      return c ? ok({ ...c, requestedAmount: wire(c.requestedAmount) }) : err(404, 'Collection not found');
    }
    if ((m = rest.match(/^collections\/([^/]+)\/intents$/)) && method === 'POST') {
      const col = this.collections.find((x) => x.chapterId === ch.id && x.id === m![1]);
      if (!col) return err(404, 'Collection not found');
      if (d['userConsented'] !== true || !d['payerIp']) return err(400, 'Consent and payer IP are required', 'VALIDATION_ERROR');
      if (this.failIntents > 0) {
        this.failIntents--;
        return err(503, 'Unavailable');
      }
      const contact = d['contactId'] === undefined ? undefined : this.contacts.find((c) => c.chapterId === ch.id && String(c.id) === String(d['contactId']));
      if (d['contactId'] !== undefined && !contact) return err(404, 'Contact not found');
      const email = contact ? contact.email : String(d['email']);
      let i = this.intents.find((x) => x.collectionId === col.id && x.email === email);
      const created = !i;
      i ??= (() => {
        const n: Intent = { id: this.id('int'), chapterId: ch.id, collectionId: col.id, email, ...(contact ? { contactId: contact.id } : {}), amount: cents(d['requestedAmount']), payments: [], payerIp: String(d['payerIp']), ...(typeof d['successUrl'] === 'string' ? { successUrl: d['successUrl'] } : {}), ...(typeof d['failureUrl'] === 'string' ? { failureUrl: d['failureUrl'] } : {}) };
        this.intents.push(n);
        return n;
      })();
      return ok(this.intentJson(i), created ? 201 : 200);
    }
    if ((m = rest.match(/^collections\/([^/]+)\/intents\/([^/]+)$/)) && method === 'GET') {
      const i = this.intents.find((x) => x.chapterId === ch.id && x.collectionId === m![1] && x.id === m![2]);
      return i ? ok(this.intentJson(i)) : err(404, 'Intent not found');
    }
    if (method === 'POST' && rest === 'payments/quotes/ach') return ok({ type: 'ach', amount: d['amount'], ...(this.quoteWithoutFee ? {} : { fee: { feeType: 'flat', amount: wire(25n) } }), totalDebit: wire(cents(d['amount']) + 25n), quotedAt: this.now().toISOString() });
    if (method === 'POST' && rest === 'payments') return this.originate(ch, d);
    if ((m = rest.match(/^payments\/([^/]+)(\/cancel)?$/))) {
      const p = this.payments.find((x) => x.chapterId === ch.id && x.id === m![1]);
      if (!p) return err(404, 'Payment not found');
      if (m[2]) {
        if (method !== 'POST') return err(404, 'No such route');
        if (p.status !== 'pending') return err(400, 'Only a pending ACH can be cancelled', 'CANNOT_CANCEL');
        p.status = 'canceled';
        this.credit(this.accountOf(ch.id), p.amount, `ACH ${p.id} cancelled`);
      }
      return ok({ id: p.id, method: p.method, status: p.status, amount: wire(p.amount), addenda: p.addenda, counterpartyId: p.counterpartyId });
    }
    if (method === 'GET' && rest === 'transactions') {
      const min = q['filter[createdAt][min]'] ? new Date(q['filter[createdAt][min]']) : undefined;
      const max = q['filter[createdAt][max]'] ? new Date(q['filter[createdAt][max]']) : undefined;
      const rows = this.ledger.filter((t) => t.chapterId === ch.id && (!min || t.at >= min) && (!max || t.at <= max)).map((t) => ({ id: t.id, accountId: t.accountId, type: 'achTransaction', direction: t.direction, amount: wire(t.amount), title: t.title, createdAt: t.at.toISOString() }));
      return this.page(rows, q);
    }
    return err(404, 'No such route');
  }

  private contactJson(c: Contact): Json {
    return { id: c.id, chapterId: c.chapterId, firstName: c.firstName, lastName: c.lastName, mobile: c.mobile, email: c.email, dateOfBirth: c.dateOfBirth, status: c.status, ...(c.status === 'Failed' ? { error: { message: 'Contact could not be verified', detail: {} } } : { error: null }), createdAt: c.createdAt.toISOString(), updatedAt: c.createdAt.toISOString(), archivedAt: null };
  }
  private walletJson(w: Wallet): Json {
    return { id: w.id, name: 'Wallet', status: w.status, accountNumber: w.accountNumber, routingNumber: '084106768', currency: 'USD', balance: wire(w.balance), hold: wire(w.hold), available: wire(w.balance - w.hold), contactId: w.contactId, product: 'wallet', createdAt: w.createdAt.toISOString() };
  }

  /** Bulk contact create: each item stands alone. A duplicate mobile or a malformed item is a Failed entry with no id. */
  private createContacts(ch: Chapter, data: unknown): Response {
    const items = Array.isArray(data) ? (data as Json[]) : [];
    if (items.length === 0 || items.length > 100) return err(400, 'Between 1 and 100 contacts', 'VALIDATION_ERROR');
    if (items.some((it) => String(it['email']).toLowerCase() === 'outage@example.test')) return err(503, 'Unavailable');
    const out = items.map((it): Json => {
      const mobile = String(it['mobile']);
      const bad = (message: string): Json => ({ firstName: it['firstName'], lastName: it['lastName'], mobile, email: it['email'], chapterId: ch.id, status: 'Failed', error: { message, detail: {} } });
      if (!/^\+[1-9]\d{7,14}$/.test(mobile) || !String(it['firstName'] ?? '') || !String(it['lastName'] ?? '') || !String(it['email'] ?? '')) return bad('Invalid contact');
      if (this.contacts.some((c) => c.chapterId === ch.id && c.mobile === mobile)) return bad('Duplicate mobile');
      const failed = String(it['email']).toLowerCase() === 'rejected@example.test';
      const c: Contact = { id: ++this.contactSeq, chapterId: ch.id, firstName: String(it['firstName']), lastName: String(it['lastName']), mobile, email: String(it['email']), dateOfBirth: typeof it['dateOfBirth'] === 'string' ? it['dateOfBirth'] : null, status: failed ? 'Failed' : 'Active', createdAt: this.now() };
      this.contacts.push(c);
      return this.contactJson(c);
    });
    return ok(out, 201);
  }

  /** Bulk account create (wallet only): idempotent on the body `idempotencyKey`, and on a contact that already has the product. */
  private createAccounts(ch: Chapter, d: Json): Response {
    const items = Array.isArray(d['items']) ? (d['items'] as Json[]) : [];
    if (items.length === 0 || items.length > 10) return err(400, 'Between 1 and 10 items', 'VALIDATION_ERROR');
    if (!isV4Key(d['idempotencyKey'])) return err(400, V4_MESSAGE, undefined, 'ValidationError');
    const results = (): Json[] =>
      items.map((it): Json => {
        const contactId = it['contactId'];
        const fail = (errorCode: string): Json => ({ contactId, product: it['product'], error: true, errorCode, message: errorCode, accountCreated: false, cardCreated: false });
        if (this.accountProvisionError) return fail(this.accountProvisionError);
        const c = this.contacts.find((x) => x.chapterId === ch.id && String(x.id) === String(contactId));
        if (!c) return fail('CONTACT_NOT_FOUND');
        if (it['product'] !== 'wallet' || c.status !== 'Active') return fail('PROVISION_FAILED');
        const have = this.wallets.find((w) => w.contactId === c.id);
        if (have) return { contactId, accountId: have.id, product: 'wallet', error: false, message: 'Account already exists', accountCreated: false, cardCreated: false };
        const w: Wallet = { id: ++this.walletSeq, chapterId: ch.id, contactId: c.id, status: c.email.toLowerCase() === 'frozen@example.test' ? 'Frozen' : 'Open', accountNumber: `9000${String(this.n++).padStart(8, '0')}`, balance: 0n, hold: 0n, createdAt: this.now() };
        this.wallets.push(w);
        return { contactId, accountId: w.id, product: 'wallet', error: false, message: 'Account created successfully', accountCreated: true, cardCreated: false };
      });
    // A failure injected by a test is never remembered under the key, so a retry can succeed.
    if (this.accountProvisionError) {
      const r = results();
      return ok({ totalProcessed: r.length, successCount: 0, failedCount: r.length, results: r });
    }
    return this.keyed(d['idempotencyKey'], d, () => {
      const r = results();
      const failedCount = r.filter((x) => x['error'] === true).length;
      return ok({ totalProcessed: r.length, successCount: r.length - failedCount, failedCount, results: r });
    });
  }

  private originate(ch: Chapter, d: Json): Response {
    const acct = this.accounts.find((a) => a.chapterId === ch.id);
    const items = Array.isArray(d['payments']) ? (d['payments'] as Json[]) : [];
    if (d['type'] !== 'achCounterparty' || items.length !== 1 || !acct) return err(400, 'Unsupported payment request', 'VALIDATION_ERROR');
    const it = items[0]!;
    if (!isV4Key(it['idempotencyKey'])) return err(400, V4_MESSAGE, undefined, 'ValidationError');
    if (String(it['counterpartyId']).startsWith('ach_rejected_201')) return ok({ id: this.id('pay'), method: 'ach', status: 'Rejected', error: 'Account closed' }, 201);
    if (this.inFlightAchCalls > 0) {
      this.inFlightAchCalls--;
      this.originateKeyed(acct, ch, it);
      // The live sandbox's shape (observed 2026-11-10): a ConflictException whose message starts with the marker, no `code`.
      return err(409, 'DUPLICATE_REQUEST: A payment with this idempotency key is already being processed', undefined, 'ConflictException');
    }
    return this.originateKeyed(acct, ch, it);
  }

  private originateKeyed(acct: Account, ch: Chapter, it: Json): Response {
    return this.keyed(it['idempotencyKey'], it, () => {
      const sent = cents(it['amount']);
      if (!(sent >= 100n) || String(it['addenda'] ?? '').length > 80) return err(400, 'Invalid amount or addenda', 'VALIDATION_ERROR');
      if (acct.balance < sent) return err(400, 'Insufficient funds', 'PAYMENT_FAILED');
      const p: Payment = { id: this.id('pay'), chapterId: ch.id, method: 'ach', status: 'pending', amount: sent, counterpartyId: String(it['counterpartyId']), addenda: String(it['addenda'] ?? ''), key: String(it['idempotencyKey']), body: createHash('sha1').update(JSON.stringify(it)).digest('hex') };
      this.payments.push(p);
      this.debit(acct, sent, `ACH ${p.id}`);
      return ok({ id: p.id, method: 'ach', status: p.status, amount: wire(sent), addenda: p.addenda, counterpartyId: p.counterpartyId, totalDebit: wire(sent), createdAt: this.now().toISOString() }, 201);
    });
  }
}

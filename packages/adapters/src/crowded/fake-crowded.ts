// FakeCrowded (T-0648): an in-memory Crowded REST API for the adapter's contract suite and tests. Its `fetch` runs the
// client in-process: bearer auth, the `data` envelope, `pagination[limit|offset]` with `meta.pagination.total`, the
// documented status vocabularies and errors, and the quirks the adapter must survive: an unmasked `accountNumber`,
// creates with no idempotency key, a 201 whose status is Rejected, a payment intent that is an upsert. Control methods
// stand in for what happens outside the API (the bank decides, a funder pays, a transfer moves on).
// Fixtures: an organization named `OUTAGE…` answers 503; a counterpartyId starting `ach_rejected_201` answers 201 Rejected;
// `inFlightAchCalls = n` makes the next n ACH creates answer 409 DUPLICATE_REQUEST (in flight).
import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;
interface Chapter { id: string; name: string; organizationId: string; parent?: string; application?: 'FormInProgress' | 'Approved' | 'Denied' | 'AwaitingDocuments' }
interface Account { id: string; chapterId: string; accountNumber: string; balance: bigint }
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
  private readonly intents: { id: string; chapterId: string; collectionId: string; email: string; amount: bigint; paid?: { id: string; at: Date } }[] = [];
  private readonly payments: Payment[] = [];
  private readonly ledger: { id: string; chapterId: string; accountId: string; direction: 'Credit' | 'Debit'; amount: bigint; title: string; at: Date }[] = [];
  private readonly keys = new Map<string, { body: string; response: Response }>();
  private readonly funded = new Map<string, Json>();
  /** A fee on collected payments, and whether the payer covered it (so the fee item is `amount - fee`). */
  collectFee: { fee: bigint; covered: boolean } = { fee: 0n, covered: false };
  /**
   * The next N ACH creates answer 409 DUPLICATE_REQUEST, as when another request with the same key is in flight (T-0695).
   * The first of them is that other request: it makes the payment (once per key), and the call after the N answers the
   * original payment, as Crowded documents.
   */
  inFlightAchCalls = 0;
  /** Quotes carry no fee (a malformed quote). */
  quoteWithoutFee = false;

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
  count(kind: 'organizations' | 'chapters' | 'collections' | 'payments'): number {
    return this[kind === 'organizations' ? 'orgs' : kind].length;
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
    if (typeof key !== 'string' || !/^[0-9a-f-]{36}$/.test(key)) return err(400, 'idempotencyKey must be a UUID', 'VALIDATION_ERROR');
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
    if (method === 'GET' && path === '/chapters') return this.page(this.chapters.filter((c) => (!q['search'] || c.name.includes(q['search'])) && (!q['filter[organizationId]'] || c.organizationId === q['filter[organizationId]'])), q);

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
      return this.page(a.map((x) => ({ id: x.id, name: 'Checking', status: 'Open', accountNumber: x.accountNumber, routingNumber: '084106768', currency: 'USD', balance: wire(x.balance), hold: wire(0n), available: wire(x.balance) })), q);
    }
    if (method === 'POST' && rest === 'subaccounts') {
      if (ch.application !== 'Approved') return err(400, 'Parent has no account', 'VALIDATION_ERROR');
      if (!d['email'] && !d['owner']) return err(400, 'owner or email required', 'VALIDATION_ERROR');
      return this.keyed(d['idempotencyKey'], d, () => {
        const sub: Chapter = { id: this.id('ch'), name: String(d['name']), organizationId: ch.organizationId, parent: ch.id };
        this.chapters.push(sub);
        this.openAccount(sub.id);
        return ok({ id: sub.id, name: sub.name, parentChapterId: ch.id, status: 'Active', createdAt: this.now().toISOString() }, 201);
      });
    }
    if (method === 'POST' && rest === 'subaccounts/fund') {
      const items = Array.isArray(data) ? (data as Json[]) : [];
      const results = items.map((it) => {
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
      let i = this.intents.find((x) => x.collectionId === col.id && x.email === d['email']);
      const created = !i;
      i ??= (() => {
        const n = { id: this.id('int'), chapterId: ch.id, collectionId: col.id, email: String(d['email']), amount: cents(d['requestedAmount']) };
        this.intents.push(n);
        return n;
      })();
      return ok({ id: i.id, requestedAmount: wire(i.amount), status: i.paid ? 'Paid' : 'Pending', paymentUrl: `https://pay.fake.invalid/${i.id}` }, created ? 201 : 200);
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

  private originate(ch: Chapter, d: Json): Response {
    const acct = this.accounts.find((a) => a.chapterId === ch.id);
    const items = Array.isArray(d['payments']) ? (d['payments'] as Json[]) : [];
    if (d['type'] !== 'achCounterparty' || items.length !== 1 || !acct) return err(400, 'Unsupported payment request', 'VALIDATION_ERROR');
    const it = items[0]!;
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

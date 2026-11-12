// CrowdedFunding (T-0700, REQ-WAL-002, REQ-WAL-003, ADR-018 A3/A4/A8): the hosted-load method of FundingPort over Crowded's
// collections and intents. A separate class from the institution adapter (its port is untouched); it reuses `CrowdedClient`
// and the `KeyLedger`. Hosted only: every other method and refunds (T-0706) answer UNSUPPORTED_METHOD; webhooks answer BAD_SIGNATURE (T-0703).
// Flag: none of its own (the registry wiring is T-0709).
//
// How the port's promises are kept on an API that gives less:
// - A collection create has no idempotency key. The title is the load reference (`Load <key>`, cut to Crowded's 50 characters, so
//   it holds no payer text), and a retry searches for it: a collection with that title and amount is reused only if no OTHER
//   key has claimed it (the claim is noted in the ledger the moment the collection is known, before the intent). Two keys that
//   share their first 45 characters therefore get two collections. The intent create is an upsert per contact and collection,
//   so a retry of it finds the same intent. A Crowded 5xx is PROVIDER_UNAVAILABLE and keeps the key: nothing is recorded as
//   done, so the same key finds the same collection. Crowded takes no body `idempotencyKey` on these two calls, so there is
//   no `uuidFromKey` here (the UUID v4 rule of T-0734 applies to the calls that do take one).
// - The load id is `crowded:<chapter>:<intent>` (`crowdedRef`). The ledger maps it to its collection, because Crowded's intent
//   path needs the collection id, and a load id we never made is UNKNOWN_LOAD with no request. Once a payment exists it may be
//   asked for as `crowded:<chapter>:<payment>` (the webhook card names a load by its payment; `metadata.paymentLoadId`); the
//   mapping is noted when a read first sees the payment. Both ids are the same load, and an answer carries the id it was
//   asked by. A second attempt on one intent after a Failed one is the same load.
// - The amount is what the member intended (`requestedAmount`), always. The fee (`fee`, `feeCovered`) is metadata. A Succeeded
//   payment whose net (the amount, less the fee where the payer covered it) is not the load's amount is not guessed at: the
//   load is `processing` and stays open for people (who bears the fee is an open question to Crowded, README question 33).
// - The hosted payment lifecycle is fake-only: the sandbox cannot drive a collection payment (README question 37).
//
// Carried from the T-0697 review: (1) the payer's IP is the CONNECTION's. The port takes it in `hosted.payerIp`, so the caller
// (the route that terminates the member's request) must read it from the socket or the trusted proxy header and never from
// the request body; this adapter can only refuse an address that is not a public one, which it does. (2) Redirect urls must be
// https (`assertHttps`) AND on `redirectHosts`, our own hosts, exact match, no wildcard, so the adapter is not an open
// redirect. (3) The url sent is the normalised `new URL(...).href`, never the raw string, with `intentId={intentId}` added
// (a caller-made `intentId` parameter is dropped). (4) `expiresAt` is persisted per load in the ledger at creation, so a read
// answers the same instant the create did; Crowded states none, so it is our own page lifetime (`pageTtlMs`), left out when
// not configured.
//
// Personal data: nothing is persisted in clear. The ledger holds vendor ids and HMAC-SHA256 values under a required secret
// `hmacKey` (a keyed hash: an IP address has too few possibilities for a bare one to hide it). Never put in an error or a log
// line: the payer's address, an url, the token. Messages are fixed text; Crowded's own are not passed on.
import { createHmac } from 'node:crypto';
import { money, type Money } from '@kesher/domain';
import { addBusinessDays, assertHttps, FundingError, isPublicIp, type FundingCreditPort, type FundingErrorCode, type FundingMethod, type FundingPort, type Load, type LoadStatus, type MirrorPort } from '@kesher/ports';
import { creditWallet, type CreditLoadView } from './credit.ts';
import { CrowdedApiError, type CrowdedClient } from './client.ts';
import { guardLedger, InMemoryKeyLedger, type KeyLedger } from './institution-banking.ts';
import { fromCents, isRecord, parseFundingRef, parseRef, ref, str, toCents } from './map.ts';

export interface CrowdedFundingOptions {
  client: CrowdedClient;
  /** The platform chapter's id at Crowded: where the collections live. Required. */
  chapterId: string;
  /** A secret of at least 32 characters (from configuration; there is no default) keying every hash this adapter stores. */
  hmacKey: string;
  /** Business days a bank transfer is held after it succeeds (ADR-018 A4). An integer from 0 to 365; set by configuration (T-0709), no default here. */
  achHoldDays: number;
  /** Our own hosts a payer may be sent back to: bare lower-case host names, exact match (no wildcard, scheme, path or credentials). Required, at least one. */
  redirectHosts: readonly string[];
  /** Remembers keys, claims and loads. In memory by default; production wires one that persists (as for the other Crowded adapters). */
  ledger?: KeyLedger;
  /** The contact at Crowded that pays for a customer, as a `c:<id>` ref (T-0699). Default: the customer id already is one. */
  contactOf?: (customerId: string) => Promise<string>;
  /** How long a payment page is offered, in milliseconds, stamped as `action.expiresAt` at creation. Left out when not set. */
  pageTtlMs?: number;
  now?: () => Date;
  /**
   * The wallet credit (T-0741, FundingCreditPort). Given, `creditWallet` exists, books through `mirror` (no second book client) and
   * `fundHolding` picks the mode (true: release-funds then the book payment; false: the book payment only). There is NO default for
   * `fundHolding`: whether Crowded holds our collected funds is README question 29, unanswered, and the credit is fake-only until it is.
   * Left out, the adapter is not a FundingCreditPort and every other caller is unchanged.
   */
  credit?: { mirror: MirrorPort; fundHolding: boolean };
}

/** What a hosted load carries beyond the port's `Load`: the payment's own ref and the processing fee, once a payment exists. */
export interface CrowdedLoadMetadata {
  [key: string]: string;
  /** The load as the payment names it: `crowded:<chapter>:<payment>`. */
  paymentLoadId: string;
  /** The processing fee in cents, as a decimal string, once a payment has one. */
  feeMinor?: string;
  /** `'true'` when the payer covered the fee on top, `'false'` when the chapter absorbed it. */
  feeCovered?: 'true' | 'false';
  /** The load as its intent names it: `crowded:<chapter>:<intent>`, the id a load was made under (a caller that asked by a payment id finds its own load with it). */
  intentLoadId: string;
}
export type CrowdedLoad = Load & { metadata?: CrowdedLoadMetadata };

interface LoadRecord {
  collectionId: string;
  intentId: string;
  expiresAt?: string;
}

const MIN_CENTS = 100n;
const MAX_TITLE = 50;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ID = /^[A-Za-z0-9_-]+$/;
const low = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
const fail = (code: FundingErrorCode, message: string): never => {
  throw new FundingError(code, message);
};

type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'returned' | 'refunded' | 'cancelled';
const PAYMENT_STATUS: Record<string, PaymentStatus> = { pending: 'pending', processing: 'processing', succeeded: 'succeeded', failed: 'failed', returned: 'returned', refunded: 'refunded', cancelled: 'cancelled', canceled: 'cancelled' };

interface PaymentView {
  id: string;
  method: 'card' | 'ach' | 'other';
  status: PaymentStatus;
  amount: Money;
  fee: Money | undefined;
  feeCovered: boolean;
  at: Date;
  settledAt: Date;
}

/** Laps of search, create and claim a key makes for its collection before it gives up. */
const COLLECTION_LAPS = 3;

/** The decoded name of one `name=value` query segment (an undecodable name is kept as it is). */
function paramName(segment: string): string {
  const raw = segment.split('=')[0]!.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export class CrowdedFunding implements FundingPort {
  private readonly c: CrowdedClient;
  private readonly chapterId: string;
  private readonly key: string;
  private readonly ledger: KeyLedger;
  private readonly holdDays: number;
  private readonly hosts: ReadonlySet<string>;
  private readonly contactOf: (customerId: string) => Promise<string>;
  private readonly ttl: number | undefined;
  private readonly now: () => Date;
  /** Calls in this process that are making a load, by key, so two at once make one collection. */
  private readonly inFlight = new Map<string, { mac: string; load: Promise<CrowdedLoad> }>();

  /** Present only when the `credit` option was given (see `isFundingCreditPort`). */
  readonly creditWallet?: FundingCreditPort['creditWallet'];
  private readonly creditLocks = new Map<string, Promise<unknown>>();

  constructor(opts: CrowdedFundingOptions) {
    if (typeof opts.hmacKey !== 'string' || opts.hmacKey.length < 32) throw new Error('CrowdedFunding needs an hmacKey of at least 32 characters');
    if (typeof opts.chapterId !== 'string' || !ID.test(opts.chapterId)) throw new Error('CrowdedFunding needs the platform chapterId');
    if (!Number.isInteger(opts.achHoldDays) || opts.achHoldDays < 0 || opts.achHoldDays > 365) throw new Error('CrowdedFunding needs achHoldDays, an integer from 0 to 365');
    if (!Array.isArray(opts.redirectHosts) || opts.redirectHosts.length === 0 || !opts.redirectHosts.every((h) => typeof h === 'string' && HOST.test(h))) {
      throw new Error('CrowdedFunding needs redirectHosts: one or more bare lower-case host names');
    }
    if (opts.pageTtlMs !== undefined && (!Number.isSafeInteger(opts.pageTtlMs) || opts.pageTtlMs <= 0)) throw new Error('CrowdedFunding pageTtlMs must be a positive integer');
    this.c = opts.client;
    this.chapterId = opts.chapterId;
    this.key = opts.hmacKey;
    this.ledger = guardLedger(opts.ledger ?? new InMemoryKeyLedger(), () => fail('PROVIDER_UNAVAILABLE', 'The funding provider is not available'));
    this.holdDays = opts.achHoldDays;
    this.hosts = new Set(opts.redirectHosts);
    this.contactOf = opts.contactOf ?? (async (customerId) => customerId);
    this.ttl = opts.pageTtlMs;
    this.now = opts.now ?? (() => new Date());
    if (opts.credit !== undefined) {
      if (typeof opts.credit.fundHolding !== 'boolean' || typeof opts.credit.mirror?.bookBatch !== 'function') throw new Error('CrowdedFunding credit needs a mirror and fundHolding (true or false, no default)');
      const deps = { client: this.c, chapterId: this.chapterId, mirror: opts.credit.mirror, fundHolding: opts.credit.fundHolding, loadPayment: (id: string) => this.creditView(id), ledger: this.ledger, locks: this.creditLocks };
      this.creditWallet = (input, key) => creditWallet(deps, input, key);
    }
  }

  /** What the credit needs of a load: its stable reference, status and amount, and the payment that stands for it (id and creation time). */
  private async creditView(loadId: string): Promise<CreditLoadView> {
    const known = await this.resolve(loadId);
    const r = await this.call(() => this.c.get(this.path(`collections/${known.record.collectionId}/intents/${known.record.intentId}`)), { missing: 'UNKNOWN_LOAD' });
    const load = await this.call(() => this.toLoad(loadId, known.record, r.data));
    const paymentId = load.metadata ? parseRef(load.metadata.paymentLoadId, 3)[2] : undefined;
    const raw = isRecord(r.data) && Array.isArray(r.data['payments']) ? r.data['payments'] : [];
    const payments = await this.call(async () => raw.map((x) => this.payment(x)));
    const p = paymentId === undefined ? undefined : payments.find((x) => x.id === paymentId);
    return { loadRef: ref('crowded', this.chapterId, known.record.intentId), status: load.status, amount: load.amount, ...(p ? { paymentId: p.id, paymentAt: p.at } : {}) };
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
  private async call<T>(fn: () => Promise<T>, opts: { missing?: FundingErrorCode; refusal?: boolean } = {}): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FundingError) throw e;
      if (e instanceof CrowdedApiError) {
        if (e.isMissing && opts.missing) throw new FundingError(opts.missing, 'Unknown load');
        if (opts.refusal && (e.status === 400 || e.status === 422)) throw new FundingError('VALIDATION_FAILED', 'The funding provider refused the load');
      }
      // Transport, auth, 429, 5xx, a malformed answer and anything unforeseen all fail secure.
      throw new FundingError('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
    }
  }

  private path(rest: string): string {
    return `/chapters/${this.chapterId}/${rest}`;
  }

  /** An https url on an allowed host, normalised, with `intentId={intentId}` appended; throws VALIDATION_FAILED with fixed text otherwise. */
  private redirect(raw: unknown, what: string): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') return fail('VALIDATION_FAILED', `${what} must be an https url`);
    assertHttps(raw, what);
    const u = new URL(raw);
    if (!this.hosts.has(u.host)) return fail('VALIDATION_FAILED', `${what} is not on a host we redirect to`);
    const hash = u.hash;
    u.hash = '';
    // Drop the caller's `intentId` by string: `URLSearchParams.toString()` would re-encode every other parameter (`%20`, `+`, `~`).
    const kept = u.search.slice(1).split('&').filter((p) => p !== '' && paramName(p) !== 'intentId');
    u.search = '';
    return `${u.href.replace(/\?$/, '')}${kept.length ? `?${kept.join('&')}&` : '?'}intentId={intentId}${hash}`;
  }

  // ---- createLoad ---------------------------------------------------------------------------------------------

  async createLoad(input: Parameters<FundingPort['createLoad']>[0], idempotencyKey: string): Promise<CrowdedLoad> {
    if (input.method !== 'hosted') return fail('UNSUPPORTED_METHOD', 'Crowded loads are hosted only');
    const v = this.validate(input, idempotencyKey);
    // The payer's address is validated but not bound: it is the connection's, so a retry of one key from another network is the same load.
    const mac = this.mac('load', v.customerId, v.amount.toString(), v.successUrl ?? '', v.failureUrl ?? '');
    const running = this.inFlight.get(idempotencyKey);
    if (running) {
      if (running.mac !== mac) return fail('VALIDATION_FAILED', 'The idempotency key was used with different input');
      return running.load;
    }
    const load = this.make(v, mac, idempotencyKey);
    this.inFlight.set(idempotencyKey, { mac, load });
    try {
      return await load;
    } finally {
      this.inFlight.delete(idempotencyKey);
    }
  }

  private validate(input: Parameters<FundingPort['createLoad']>[0], key: string) {
    const i = input as { customerId?: unknown; amount?: Money; hosted?: unknown };
    if (typeof key !== 'string' || key === '' || key.length > 128) return fail('VALIDATION_FAILED', 'The idempotency key must be 1 to 128 characters');
    if (typeof i.customerId !== 'string' || i.customerId === '') return fail('VALIDATION_FAILED', 'customerId is required');
    const a = i.amount;
    if (!a || a.currency !== 'USD') return fail('VALIDATION_FAILED', 'Crowded amounts are USD only');
    if (typeof a.minor !== 'bigint' || a.minor < MIN_CENTS) return fail('VALIDATION_FAILED', 'A load is at least $1.00');
    if (a.minor > BigInt(Number.MAX_SAFE_INTEGER)) return fail('VALIDATION_FAILED', 'The amount is too large for the provider');
    const h = i.hosted;
    if (!isRecord(h)) return fail('VALIDATION_FAILED', 'A hosted load needs the payer address and consent');
    if (typeof h['payerIp'] !== 'string' || !isPublicIp(h['payerIp'])) return fail('VALIDATION_FAILED', 'The payer address must be a public IP address');
    if (h['userConsented'] !== true) return fail('VALIDATION_FAILED', 'The payer must have consented');
    const successUrl = this.redirect(h['successUrl'], 'successUrl');
    const failureUrl = this.redirect(h['failureUrl'], 'failureUrl');
    return { customerId: i.customerId, amount: a.minor, payerIp: h['payerIp'], ...(successUrl ? { successUrl } : {}), ...(failureUrl ? { failureUrl } : {}) };
  }

  private async make(v: { customerId: string; amount: bigint; payerIp: string; successUrl?: string; failureUrl?: string }, mac: string, key: string): Promise<CrowdedLoad> {
    const keyK = `load:key:${key}`;
    const bound = await this.ledger.get(keyK);
    if (bound) {
      if (bound.body !== mac) return fail('VALIDATION_FAILED', 'The idempotency key was used with different input');
      return this.getLoad(bound.result as string);
    }
    const contactId = parseFundingRef('c', await this.call(() => this.contactOf(v.customerId)));
    if (!contactId) return fail('VALIDATION_FAILED', 'customerId must name a contact');

    // `Load <key>` cut to 50: the load reference, and nothing of the payer.
    const title = `Load ${key.replace(/[^A-Za-z0-9:_-]/g, '-')}`.slice(0, MAX_TITLE);
    const requested = money(v.amount, 'USD');
    const made = await this.call(
      async () => {
        const collectionId = await this.collection(title, requested, key);
        const r = await this.c.post(this.path(`collections/${collectionId}/intents`), {
          contactId,
          requestedAmount: toCents(requested),
          payerIp: v.payerIp,
          userConsented: true,
          ...(v.successUrl ? { successUrl: v.successUrl } : {}),
          ...(v.failureUrl ? { failureUrl: v.failureUrl } : {}),
        });
        if (!isRecord(r.data)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable intent');
        this.pageUrl(r.data['paymentUrl']);
        return { collectionId, intentId: str(r.data['id']) };
      },
      { refusal: true },
    );
    const loadId = ref('crowded', this.chapterId, made.intentId);
    const record: LoadRecord = { ...made, ...(this.ttl === undefined ? {} : { expiresAt: new Date(this.now().getTime() + this.ttl).toISOString() }) };
    // The record first, then the key: a crash between them leaves a load a retry finds by its claimed collection and intent upsert.
    await this.ledger.put(`load:intent:${loadId}`, { body: '', result: record });
    await this.ledger.put(keyK, { body: mac, result: loadId });
    return this.getLoad(loadId);
  }

  /** The collection for this key: one Crowded already holds under the title and amount that no other key has claimed, else a new one. */
  private async collection(title: string, amount: Money, key: string): Promise<string> {
    // Bounded: each lap that loses a claim does so to another key that made progress, so a few laps always end it.
    for (let lap = 0; lap < COLLECTION_LAPS; lap++) {
      for await (const item of this.c.list(this.path('collections'), { search: title })) {
        if (!isRecord(item) || item['title'] !== title || fromCents(item['requestedAmount']).minor !== amount.minor) continue;
        const id = str(item['id']);
        if (await this.claim(id, key)) return id;
      }
      const r = await this.c.post(this.path('collections'), { title, requestedAmount: toCents(amount) });
      if (!isRecord(r.data)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable collection');
      const id = str(r.data['id']);
      // Another key may have listed and claimed this one between our create and our claim: then it is theirs, and we look again.
      if (await this.claim(id, key)) return id;
    }
    return fail('PROVIDER_UNAVAILABLE', 'The funding provider is not available');
  }

  /** Claims a collection for a key in one atomic step (the ledger's insert-if-absent): true when it is now this key's, false when another key holds it. */
  private async claim(collectionId: string, key: string): Promise<boolean> {
    const k = `load:claim:${collectionId}`;
    const entry = { body: '', result: key };
    if (this.ledger.putIfAbsent) {
      if (await this.ledger.putIfAbsent(k, entry)) return true;
      return (await this.ledger.get(k))?.result === key;
    }
    // A ledger with no insert-if-absent: a read then a write, which two concurrent keys can both win.
    const owner = await this.ledger.get(k);
    if (owner !== undefined && owner.result !== key) return false;
    await this.ledger.put(k, entry);
    return true;
  }

  /** The payment page url: https only, normalised. */
  private pageUrl(raw: unknown): string {
    if (typeof raw !== 'string') return fail('PROVIDER_UNAVAILABLE', 'The funding provider gave no payment page');
    try {
      assertHttps(raw, 'paymentUrl');
      return new URL(raw).href;
    } catch {
      return fail('PROVIDER_UNAVAILABLE', 'The funding provider gave no payment page');
    }
  }

  // ---- getLoad ------------------------------------------------------------------------------------------------

  async getLoad(loadId: string): Promise<CrowdedLoad> {
    const known = await this.resolve(loadId);
    const r = await this.call(() => this.c.get(this.path(`collections/${known.record.collectionId}/intents/${known.record.intentId}`)), { missing: 'UNKNOWN_LOAD' });
    return this.call(() => this.toLoad(loadId, known.record, r.data));
  }

  /** The record of a load id we made, by its intent or by a payment already seen on it; UNKNOWN_LOAD for anything else, with no request. */
  private async resolve(loadId: unknown): Promise<{ record: LoadRecord }> {
    let parts: string[];
    try {
      parts = typeof loadId === 'string' ? parseRef(loadId, 3) : [];
    } catch {
      parts = [];
    }
    if (parts.length !== 3 || parts[0] !== 'crowded' || parts[1] !== this.chapterId) return fail('UNKNOWN_LOAD', 'Unknown load');
    const direct = await this.ledger.get(`load:intent:${loadId as string}`);
    if (direct) return { record: direct.result as LoadRecord };
    const viaPayment = await this.ledger.get(`load:payment:${loadId as string}`);
    const intent = viaPayment ? await this.ledger.get(`load:intent:${viaPayment.result as string}`) : undefined;
    if (!intent) return fail('UNKNOWN_LOAD', 'Unknown load');
    return { record: intent.result as LoadRecord };
  }

  private async toLoad(askedId: string, record: LoadRecord, data: unknown): Promise<CrowdedLoad> {
    if (!isRecord(data)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable intent');
    const amount = fromCents(data['requestedAmount']);
    const payments = (Array.isArray(data['payments']) ? data['payments'] : []).map((p) => this.payment(p));
    const intentStatus = low(data['status']);
    const intentLoadId = ref('crowded', this.chapterId, record.intentId);
    const base = (over: Partial<CrowdedLoad> & { method: FundingMethod; status: LoadStatus }): CrowdedLoad => ({ loadId: askedId, amount, ...over });

    // The payment that stands for the load: a Succeeded one, else one still moving, else the latest. A second attempt after a Failed one is the same load.
    const latest = (xs: PaymentView[]) => xs.reduce<PaymentView | undefined>((best, p) => (!best || p.at.getTime() >= best.at.getTime() ? p : best), undefined);
    const p = latest(payments.filter((x) => x.status === 'succeeded')) ?? latest(payments.filter((x) => x.status === 'pending' || x.status === 'processing')) ?? latest(payments);

    if (!p) {
      if (intentStatus === 'returned') return base({ method: 'hosted', status: 'failed', failureCode: 'RETURNED' });
      if (intentStatus === 'cancelled' || intentStatus === 'canceled') return base({ method: 'hosted', status: 'failed' });
      return base({ method: 'hosted', status: 'requires_action', action: { type: 'payment_page', url: this.pageUrl(data['paymentUrl']), ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) } });
    }

    // Remember EVERY payment seen on the intent for this load (a failed first attempt too), so a webhook that names any of them
    // can be read back (T-0703). The one that stands for the load is the one named in the metadata.
    for (const x of payments) {
      const key = `load:payment:${ref('crowded', this.chapterId, x.id)}`;
      if (!(await this.ledger.get(key))) await this.ledger.put(key, { body: '', result: intentLoadId });
    }
    const paymentLoadId = ref('crowded', this.chapterId, p.id);
    const metadata: CrowdedLoadMetadata = { paymentLoadId, intentLoadId, ...(p.fee ? { feeMinor: p.fee.minor.toString(), feeCovered: p.feeCovered ? ('true' as const) : ('false' as const) } : {}) };
    const method: FundingMethod = p.method === 'other' ? 'hosted' : p.method;
    const out = (over: { status: LoadStatus; holdUntil?: string; failureCode?: string }): CrowdedLoad => base({ method, ...over, metadata });

    switch (p.status) {
      case 'pending':
      case 'processing':
        return out({ status: 'processing' });
      case 'succeeded': {
        // The net is what the member intended: the amount less the fee where the payer covered it on top. Anything else is not guessed at.
        const net = p.feeCovered && p.fee ? p.amount.minor - p.fee.minor : p.amount.minor;
        if (net !== amount.minor || p.method === 'other') return out({ status: 'processing' });
        if (p.method === 'ach') return out({ status: 'on_hold', holdUntil: addBusinessDays(await this.firstSeenSuccess(p), this.holdDays).toISOString() });
        return out({ status: 'succeeded' });
      }
      case 'returned':
        return out({ status: 'failed', failureCode: 'RETURNED' });
      case 'refunded':
        return out({ status: 'failed', failureCode: 'REFUNDED' });
      case 'failed':
      case 'cancelled':
        return out({ status: 'failed', ...(intentStatus === 'returned' ? { failureCode: 'RETURNED' } : {}) });
    }
  }

  /**
   * The instant this payment was first seen Succeeded, kept per payment: Crowded's own `updatedAt` moves on later edits, and a hold
   * that moved with it would drift. The first read to see the success fixes it; every later read, from any process on the ledger, answers it.
   */
  private async firstSeenSuccess(p: PaymentView): Promise<Date> {
    const key = `load:succeeded:${p.id}`;
    const seen = await this.ledger.get(key);
    const at = typeof seen?.result === 'string' ? new Date(seen.result) : undefined;
    if (at && !Number.isNaN(at.getTime())) return at;
    await this.ledger.put(key, { body: '', result: p.settledAt.toISOString() });
    return p.settledAt;
  }

  private payment(raw: unknown): PaymentView {
    if (!isRecord(raw)) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent an unreadable payment');
    const status = PAYMENT_STATUS[low(raw['status'])];
    if (!status) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent a payment status we do not know');
    const m = low(raw['method']);
    const at = new Date(typeof raw['createdAt'] === 'string' ? raw['createdAt'] : NaN);
    // When it settled: Crowded's `completedAt` where it sends one, else the last update, else its creation (README question 35).
    const settledRaw = raw['completedAt'] ?? raw['updatedAt'] ?? raw['createdAt'];
    const settledAt = new Date(typeof settledRaw === 'string' ? settledRaw : NaN);
    if (Number.isNaN(at.getTime()) || Number.isNaN(settledAt.getTime())) return fail('PROVIDER_UNAVAILABLE', 'The funding provider sent a payment without a date');
    const fee = raw['fee'] === undefined || raw['fee'] === null ? undefined : fromCents(raw['fee']);
    return { id: str(raw['id']), method: m === 'card' ? 'card' : m === 'ach' ? 'ach' : 'other', status, amount: fromCents(raw['amount']), fee, feeCovered: raw['feeCovered'] === true, at, settledAt };
  }

  // ---- not here -----------------------------------------------------------------------------------------------

  refund: FundingPort['refund'] = () => Promise.reject(new FundingError('UNSUPPORTED_METHOD', 'Refunds of Crowded loads are not built yet'));

  getRefund: FundingPort['getRefund'] = () => Promise.reject(new FundingError('UNSUPPORTED_METHOD', 'Refunds of Crowded loads are not built yet'));

  /**
   * Fail secure (T-0703): Crowded sends BATCHES, which do not fit a port that parses one event, and a payment's state is only
   * ever taken from a re-read. So this accepts nothing: a Crowded delivery on `/hooks/funding` is refused and recorded, and only
   * `/webhooks/crowded` (batch, HMAC over the raw bytes, a handler that re-reads) accepts it.
   */
  parseWebhook: FundingPort['parseWebhook'] = () => Promise.reject(new FundingError('BAD_SIGNATURE', 'Crowded deliveries go to /webhooks/crowded'));
}

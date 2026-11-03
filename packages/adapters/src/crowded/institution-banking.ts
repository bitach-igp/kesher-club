// CrowdedInstitutionBankingAdapter (T-0648, REQ-INS-022, REQ-INS-024): InstitutionBankingPort over Crowded's REST API.
// Flag: institutions.usBanking (config/flags.json), default off; no vendor id leaves here except as an opaque `*Ref`
// string for ops.external_ref. Refs: an entity is a chapter id; a collection, intent and payment are
// `<chapter>:<id>[:<id>]` because Crowded addresses them under their chapter.
//
// What Crowded's API does not give us, and how this adapter covers it:
// - Organization, chapter, collection and contact creates take no idempotency key. A create first looks the object up
//   by name (organizations, chapters, collections) and reuses an exact match; and a KeyLedger remembers key -> result
//   (and body, so the same key with another body is IDEMPOTENCY_CONFLICT). The default ledger is in memory: production
//   wires one that persists (T-0650). Creates that do take a key (sub-accounts, payments) send a UUIDv5 of ours.
// - A payment intent needs the payer's IP and consent. The port carries neither, and an adapter must not assert
//   consent for someone: the caller supplies `payer` explicitly, or createPaymentPage refuses.
// - Quoting an ACH needs a saved counterparty (`collectionCounterpartyRef`, Kesher's collection account), set up by ops.
// - Crowded documents no arrival date for an ACH, so `quoteAch` returns none; no `settled` status, so `sent` is as far as
//   it goes; book transfers are checking <-> contact accounts only, so a transfer to a sub-account uses the
//   parent-to-sub-account funding call, and only that direction.
// - A pooled account (no number of its own) is not something Crowded offers as far as its docs say: every sub-account
//   has its own deposit account, so `hasOwnAccountNumber` is true.
// Never returned or logged: the account number (last four only), names, emails, mobiles, officers, or the token.
import { createHash } from 'node:crypto';
import { type Money } from '@kesher/domain';
import {
  InstitutionBankingError,
  isAddenda,
  requireUsd,
  type AchStatus,
  type ApplicationStatus,
  type BankTransaction,
  type CollectedPayment,
  type Funder,
  type Holder,
  type InboundEvent,
  type InstitutionBankingPort,
  type WebhookResult,
} from '@kesher/ports';
import { CrowdedApiError, CrowdedTransportError, type CrowdedClient } from './client.ts';
import { achStatus, applicationStatus, collectedStatus, date, fromCents, isRecord, last4, parseRef, ref, splitName, str, toCents, uuidFromKey } from './map.ts';

/** Remembers key -> result (with the body it was made for) so a retry answers the same object. */
export interface KeyLedger {
  get(key: string): Promise<{ body: string; result: unknown } | undefined>;
  put(key: string, entry: { body: string; result: unknown }): Promise<void>;
}

export class InMemoryKeyLedger implements KeyLedger {
  private readonly m = new Map<string, { body: string; result: unknown }>();
  async get(key: string) {
    return this.m.get(key);
  }
  async put(key: string, entry: { body: string; result: unknown }) {
    this.m.set(key, entry);
  }
}

export interface CrowdedInstitutionBankingOptions {
  client: CrowdedClient;
  ledger?: KeyLedger;
  /** One of Crowded's business verticals; chapters need one. */
  businessVertical?: string;
  /** The contact for sub-accounts (Crowded wants an owner or an email). Required to create one. */
  subAccountEmail?: string;
  /** Crowded's id of the saved counterparty for Kesher's US collection account. Required to quote an ACH. */
  collectionCounterpartyRef?: string;
  /** The payer's IP and consent for payment intents. Required to create a payment page; never assumed. */
  payer?: { ip: string; consented: true };
  /** Verifies the webhook signature over the raw body (T-0649 provides the HMAC one). Without it every webhook is refused. */
  verifyWebhookSignature?: (headers: Record<string, string>, rawBody: string) => boolean | Promise<boolean>;
}

const bigintJson = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
/** Crowded's smallest collection and ACH: $1.00. */
const MIN_CENTS = 100n;

export class CrowdedInstitutionBankingAdapter implements InstitutionBankingPort {
  private readonly c: CrowdedClient;
  private readonly ledger: KeyLedger;
  private readonly o: CrowdedInstitutionBankingOptions;

  constructor(opts: CrowdedInstitutionBankingOptions) {
    this.o = opts;
    this.c = opts.client;
    this.ledger = opts.ledger ?? new InMemoryKeyLedger();
  }

  // ---- plumbing -----------------------------------------------------------------------------------------------

  /** Maps Crowded's failures to the port's closed set. Unknown responses fail secure as PROVIDER_UNAVAILABLE. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof InstitutionBankingError) throw e;
      if (e instanceof CrowdedTransportError) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded could not be reached');
      if (e instanceof CrowdedApiError) {
        if (e.isAuth || e.isOutage) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded is not available');
        if (e.isMissing) throw new InstitutionBankingError('NOT_FOUND', 'Crowded does not know that object');
        if (e.code === 'CANNOT_CANCEL') throw new InstitutionBankingError('NOT_CANCELLABLE', 'The payment can no longer be cancelled');
        if (e.status === 409 || e.code === 'DUPLICATE_REQUEST') throw new InstitutionBankingError('IDEMPOTENCY_CONFLICT', 'Crowded saw that key with another request');
        if (e.status === 400 || e.status === 422) throw new InstitutionBankingError('VALIDATION_FAILED', e.message);
      }
      throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Unexpected answer from Crowded');
    }
  }

  /**
   * Same key + same body answers the remembered result; the same key with another body is IDEMPOTENCY_CONFLICT, decided
   * from the ledger before anything is sent. Only a SHA-256 of the body is kept, never the body: it holds names, emails
   * and an EIN. `before` runs after a ledger miss and before the create (a read that must pass first).
   */
  private async idem<T>(scope: string, key: string, body: unknown, make: () => Promise<T>, before?: () => Promise<void>): Promise<T> {
    const k = `${scope}:${key}`;
    const digest = createHash('sha256').update(JSON.stringify(body, bigintJson)).digest('hex');
    const prior = await this.ledger.get(k);
    if (prior) {
      if (prior.body !== digest) throw new InstitutionBankingError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different body');
      return prior.result as T;
    }
    await before?.();
    const result = await make();
    await this.ledger.put(k, { body: digest, result });
    return result;
  }

  private async note(key: string, value: string): Promise<void> {
    await this.ledger.put(key, { body: '', result: value });
  }
  private async noted(key: string): Promise<string | undefined> {
    const e = await this.ledger.get(key);
    return typeof e?.result === 'string' ? e.result : undefined;
  }

  /**
   * A call that moves money. Crowded dedupes a repeated `idempotencyKey` for about 48 hours, but how it answers the
   * repeat is undocumented (Q14). A 409 here is therefore never read as our own IDEMPOTENCY_CONFLICT (the ledger decides
   * that): it means Crowded may already hold this payment, so the outcome is unknown. The caller must read it back and
   * must not resend under a new key.
   */
  private async moneyCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CrowdedApiError && (e.status === 409 || e.code === 'DUPLICATE_REQUEST')) {
        throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded may already hold this payment: read it back before retrying, and do not resend under a new key');
      }
      throw e;
    }
  }

  private async openAccount(chapterId: string): Promise<{ id: string; balance: Money; accountNumber: unknown }> {
    for await (const a of this.c.list(`/chapters/${chapterId}/accounts`)) {
      if (isRecord(a) && String(a['status']).toLowerCase() === 'open') return { id: str(a['id']), balance: fromCents(a['balance'], a['currency']), accountNumber: a['accountNumber'] };
    }
    throw new InstitutionBankingError('NOT_APPROVED', 'The application is not approved');
  }

  private async findByName(path: string, search: string, query: Record<string, string>, matches: (item: Record<string, unknown>) => boolean): Promise<string | undefined> {
    for await (const item of this.c.list(path, { search, ...query })) {
      if (isRecord(item) && matches(item)) return str(item['id']);
    }
    return undefined;
  }

  // ---- entity, application, account -----------------------------------------------------------------------------

  async createEntity(input: { holder: Holder; institutionId: string; legalName: string; ein: string; idempotencyKey: string }): Promise<{ entityRef: string }> {
    const name = input.legalName.trim();
    if (!name || name.length > 255 || !/^\d{2}-?\d{7}$/.test(input.ein)) throw new InstitutionBankingError('VALIDATION_FAILED', 'A legal name and a 9-digit EIN are required');
    return this.call(() =>
      this.idem('entity', input.idempotencyKey, input, async () => {
        const orgId =
          (await this.findByName('/organizations', name, {}, (o) => o['name'] === name)) ?? str(((await this.c.post('/organizations', { name })).data as Record<string, unknown>)['id']);
        const chapterId =
          (await this.findByName('/chapters', name, { 'filter[organizationId]': orgId }, (o) => o['name'] === name)) ??
          str(((await this.c.post('/chapters', { name, organizationId: orgId, businessVertical: this.o.businessVertical ?? 'EducationalServices' })).data as Record<string, unknown>)['id']);
        await this.note(`holder:${chapterId}`, input.holder);
        return { entityRef: chapterId };
      }),
    );
  }

  async startApplication(input: { entityRef: string; applicantIp: string }): Promise<{ formUrl: string }> {
    if (!/^[0-9a-f.:]{3,45}$/i.test(input.applicantIp)) throw new InstitutionBankingError('VALIDATION_FAILED', 'applicantIp must be an IP address');
    return this.call(async () => {
      const r = await this.c.post(`/chapters/${parseRef(input.entityRef, 1)[0]}/applications/form`, { contactIp: input.applicantIp });
      const url = isRecord(r.data) ? r.data['url'] : undefined;
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded gave no application form');
      return { formUrl: url };
    });
  }

  async applicationStatus(entityRef: string): Promise<ApplicationStatus> {
    const [chapterId] = parseRef(entityRef, 1);
    try {
      return await this.call(async () => {
        const r = await this.c.get(`/chapters/${chapterId}/applications`);
        return applicationStatus(isRecord(r.data) ? r.data['status'] : undefined);
      });
    } catch (e) {
      // 400: nothing submitted yet, so the application is pending.
      if (e instanceof InstitutionBankingError && e.code === 'VALIDATION_FAILED') return 'pending';
      throw e;
    }
  }

  async account(entityRef: string): Promise<{ accountRef: string; balance: Money; last4: string }> {
    return this.call(async () => {
      const a = await this.openAccount(parseRef(entityRef, 1)[0]!);
      return { accountRef: a.id, balance: a.balance, last4: last4(a.accountNumber) };
    });
  }

  async createSubAccount(input: { entityRef: string; institutionId: string; idempotencyKey: string }): Promise<{ subAccountRef: string; hasOwnAccountNumber: boolean }> {
    const [parent] = parseRef(input.entityRef, 1);
    if ((await this.noted(`holder:${parent}`)) === 'institution' || (await this.noted(`parent:${parent}`)) !== undefined) {
      throw new InstitutionBankingError('VALIDATION_FAILED', 'Only a platform entity has sub-accounts');
    }
    if (!this.o.subAccountEmail) throw new InstitutionBankingError('VALIDATION_FAILED', 'No contact is configured for sub-accounts');
    return this.call(() =>
      this.idem(
        'sub',
        input.idempotencyKey,
        input,
        async () => {
          const r = await this.c.post(`/chapters/${parent}/subaccounts`, { name: `Institution ${input.institutionId}`, email: this.o.subAccountEmail, idempotencyKey: uuidFromKey(`sub:${input.idempotencyKey}`) });
          const id = str((r.data as Record<string, unknown>)['id']);
          await this.note(`parent:${id}`, parent!);
          return { subAccountRef: id, hasOwnAccountNumber: true };
        },
        async () => void (await this.openAccount(parent!)),
      ),
    );
  }

  // ---- collections ----------------------------------------------------------------------------------------------

  async createCollection(input: { entityRef: string; title: string; amount: Money; idempotencyKey: string }): Promise<{ collectionRef: string }> {
    requireUsd(input.amount);
    const title = input.title.trim();
    if (!title || title.length > 50) throw new InstitutionBankingError('VALIDATION_FAILED', 'A collection needs a title of at most 50 characters');
    const [chapterId] = parseRef(input.entityRef, 1);
    return this.call(() =>
      this.idem(
        'collection',
        input.idempotencyKey,
        input,
        async () => {
          if (input.amount.minor < MIN_CENTS) throw new InstitutionBankingError('VALIDATION_FAILED', 'A collection is at least $1.00');
          const found = await this.findByName(`/chapters/${chapterId}/collections`, title, {}, (c) => sameCents(c['requestedAmount'], input.amount) && c['title'] === title);
          const id = found ?? str(((await this.c.post(`/chapters/${chapterId}/collections`, { title, requestedAmount: toCents(input.amount) })).data as Record<string, unknown>)['id']);
          return { collectionRef: ref(chapterId!, id) };
        },
        async () => void (await this.openAccount(chapterId!)),
      ),
    );
  }

  async createPaymentPage(input: { collectionRef: string; funder: Funder; idempotencyKey: string }): Promise<{ intentRef: string; paymentUrl: string }> {
    const [chapterId, collectionId] = parseRef(input.collectionRef, 2);
    const f = input.funder;
    const mobile = f.mobile.startsWith('+') ? f.mobile : `+${f.mobile}`;
    if (!f.name.trim() || !f.email.includes('@') || !/^\+\d{7,15}$/.test(mobile)) throw new InstitutionBankingError('VALIDATION_FAILED', 'A funder needs a name, an email and a mobile');
    if (!this.o.payer) throw new InstitutionBankingError('VALIDATION_FAILED', 'No payer consent is configured for payment pages');
    const payer = this.o.payer;
    return this.call(() =>
      this.idem('intent', input.idempotencyKey, input, async () => {
        const col = await this.c.get(`/chapters/${chapterId}/collections/${collectionId}`);
        const requestedAmount = toCents(fromCents(isRecord(col.data) ? col.data['requestedAmount'] : undefined));
        const { firstName, lastName } = splitName(f.name);
        const r = await this.c.post(`/chapters/${chapterId}/collections/${collectionId}/intents`, { firstName, lastName, email: f.email, mobile, requestedAmount, payerIp: payer.ip, userConsented: payer.consented });
        const d = r.data as Record<string, unknown>;
        const url = d['paymentUrl'];
        if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded gave no payment page');
        return { intentRef: ref(chapterId!, collectionId!, str(d['id'])), paymentUrl: url };
      }),
    );
  }

  async *collectPayments(input: { entityRef: string; since: Date }): AsyncIterable<CollectedPayment> {
    const [chapterId] = parseRef(input.entityRef, 1);
    const seen = new Set<string>();
    const rows = this.c.list('/collect-payments', { 'filter[chapterId]': chapterId, 'filter[createdAt][min]': input.since.toISOString() });
    for await (const item of this.guard(rows)) {
      if (!isRecord(item)) continue;
      const status = collectedStatus(item['status']);
      if (status === undefined) continue;
      const id = str(item['id']);
      if (seen.has(id)) continue;
      seen.add(id);
      const collection = str((item['collectRequest'] as Record<string, unknown> | undefined)?.['id']);
      const intent = str((item['intent'] as Record<string, unknown> | undefined)?.['id']);
      // `amount` includes the fee. Where the payer covered it, the fee item's amount is what is left (Q13 in the vendor notes).
      const gross = fromCents(item['amount']);
      const fee = item['feeCovered'] === true && item['fee'] !== undefined ? fromCents(item['fee']) : undefined;
      if (fee && (fee.minor < 0n || fee.minor >= gross.minor)) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded sent a fee that does not fit the payment');
      const amount = fee ? { ...gross, minor: gross.minor - fee.minor } : gross;
      yield { paymentRef: ref(chapterId!, id), intentRef: ref(chapterId!, collection, intent), collectionRef: ref(chapterId!, collection), amount, status, paidAt: date(item['updatedAt'] ?? item['createdAt']) };
    }
  }

  // ---- ACH and book transfers -----------------------------------------------------------------------------------

  async quoteAch(input: { entityRef: string; amount: Money }): Promise<{ fee: Money; arrivesOn?: string }> {
    requireUsd(input.amount);
    if (input.amount.minor < MIN_CENTS) throw new InstitutionBankingError('VALIDATION_FAILED', 'An ACH is at least $1.00');
    if (!this.o.collectionCounterpartyRef) throw new InstitutionBankingError('VALIDATION_FAILED', 'No collection account is configured to quote against');
    const [chapterId] = parseRef(input.entityRef, 1);
    return this.call(async () => {
      await this.openAccount(chapterId!);
      const r = await this.c.post(`/chapters/${chapterId}/payments/quotes/ach`, { amount: toCents(input.amount), applyFee: true, sameDay: false, counterpartyId: this.o.collectionCounterpartyRef });
      const fee = isRecord(r.data) && isRecord(r.data['fee']) ? r.data['fee']['amount'] : undefined;
      if (fee === undefined) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded quoted no fee');
      return { fee: fromCents(fee) };
    });
  }

  async sendAch(input: { entityRef: string; counterpartyRef: string; amount: Money; addenda: string; idempotencyKey: string }): Promise<{ paymentRef: string; status: AchStatus }> {
    requireUsd(input.amount);
    if (!isAddenda(input.addenda)) throw new InstitutionBankingError('VALIDATION_FAILED', 'addenda must be at most 80 printable ASCII characters');
    const [chapterId] = parseRef(input.entityRef, 1);
    return this.call(() =>
      this.idem(
        'ach',
        input.idempotencyKey,
        input,
        async () => {
        if (input.amount.minor < MIN_CENTS) throw new InstitutionBankingError('VALIDATION_FAILED', 'An ACH is at least $1.00');
        const r = await this.moneyCall(() => this.c.post(`/chapters/${chapterId}/payments`, {
          type: 'achCounterparty',
          payments: [{ counterpartyId: input.counterpartyRef, amount: toCents(input.amount), description: 'KESHER', addenda: input.addenda, sameDay: false, applyFee: true, idempotencyKey: uuidFromKey(`ach:${input.idempotencyKey}`) }],
        }));
        const p = firstItem(r.data);
        // A bulk-style item says `status: success | failed` and puts the payment's own status in `paymentStatus`.
        const status = p['paymentStatus'] ?? p['status'];
        // A business rejection can arrive as a 201 whose status says Rejected, and a bulk-style 200 can carry an item error.
        if (String(status).toLowerCase() === 'rejected' || p['error'] !== undefined || p['errorCode'] !== undefined || String(p['status']).toLowerCase() === 'failed') {
          throw new InstitutionBankingError('REJECTED', 'The provider rejected the payment');
        }
        return { paymentRef: ref(chapterId!, str(p['id'] ?? p['paymentId'])), status: achStatus(status) };
        },
        async () => void (await this.openAccount(chapterId!)),
      ),
    );
  }

  async achStatus(paymentRef: string): Promise<AchStatus> {
    const [chapterId, paymentId] = parseRef(paymentRef, 2);
    return this.call(async () => {
      const r = await this.c.get(`/chapters/${chapterId}/payments/${paymentId}`);
      return achStatus(isRecord(r.data) ? r.data['status'] : undefined);
    });
  }

  async cancelAch(paymentRef: string): Promise<AchStatus> {
    const [chapterId, paymentId] = parseRef(paymentRef, 2);
    return this.call(async () => {
      const now = await this.achStatus(paymentRef);
      if (now === 'cancelled') return now;
      try {
        const r = await this.c.post(`/chapters/${chapterId}/payments/${paymentId}/cancel`);
        return achStatus(isRecord(r.data) ? r.data['status'] : undefined);
      } catch (e) {
        // Cancelled by someone else between our read and our call: that is the answer, not a refusal.
        if (e instanceof CrowdedApiError && e.code === 'CANNOT_CANCEL' && (await this.achStatus(paymentRef)) === 'cancelled') return 'cancelled';
        throw e;
      }
    });
  }

  async bookTransfer(input: { fromRef: string; toRef: string; amount: Money; memo: string; idempotencyKey: string }): Promise<{ transferRef: string }> {
    requireUsd(input.amount);
    if (!isAddenda(input.memo)) throw new InstitutionBankingError('VALIDATION_FAILED', 'memo must be at most 80 printable ASCII characters');
    const [from] = parseRef(input.fromRef, 1);
    const [to] = parseRef(input.toRef, 1);
    if (from === to) throw new InstitutionBankingError('VALIDATION_FAILED', 'A transfer needs two different accounts');
    // Crowded funds a sub-account from its parent; its book transfers are checking <-> contact accounts. The other
    // direction is not documented, so it is refused rather than guessed.
    if ((await this.noted(`parent:${from}`)) !== undefined) throw new InstitutionBankingError('VALIDATION_FAILED', 'Crowded does not move money out of a sub-account by book transfer');
    const parent = await this.noted(`parent:${to}`);
    if (parent !== undefined && parent !== from) throw new InstitutionBankingError('VALIDATION_FAILED', "A book transfer moves money between one platform's own accounts");
    return this.call(() =>
      this.idem('book', input.idempotencyKey, input, async () => {
        const uuid = uuidFromKey(`book:${input.idempotencyKey}`);
        const r = await this.moneyCall(() => this.c.post(`/chapters/${from}/subaccounts/fund`, [{ id: to, amount: toCents(input.amount), description: input.memo, idempotencyKey: uuid }]));
        // The response is undocumented. Money may have moved, so a shape we cannot read is an unknown outcome, not a success.
        const item = Array.isArray(r.data) && r.data.length === 1 ? r.data[0] : undefined;
        if (!isRecord(item)) throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded answered the funding call in a shape we do not know: read the account back before retrying');
        // A failed item is a refusal (insufficient funds, a bad sub-account): VALIDATION_FAILED, as for a simulator transfer.
        if (item['error'] !== undefined || ['failed', 'rejected'].includes(String(item['status']).toLowerCase())) throw new InstitutionBankingError('VALIDATION_FAILED', 'The provider refused the transfer');
        return { transferRef: ref(from!, 'fund', uuid) };
      }),
    );
  }

  async *transactions(input: { entityRef: string; from: Date; to: Date }): AsyncIterable<BankTransaction> {
    const [chapterId] = parseRef(input.entityRef, 1);
    const seen = new Set<string>();
    const rows = this.c.list(`/chapters/${chapterId}/transactions`, { 'filter[createdAt][min]': input.from.toISOString(), 'filter[createdAt][max]': input.to.toISOString() });
    for await (const t of this.guard(rows)) {
      if (!isRecord(t)) continue;
      const id = str(t['id']);
      if (seen.has(id)) continue;
      seen.add(id);
      const kind = String(t['direction']).toLowerCase() === 'debit' ? 'debit' : 'credit';
      const amount = fromCents(t['amount']);
      yield { transactionRef: ref(chapterId!, id), kind, amount: { ...amount, minor: amount.minor < 0n ? -amount.minor : amount.minor }, postedAt: date(t['createdAt']), description: String(t['title'] ?? t['summary'] ?? '').slice(0, 200) };
    }
  }

  // ---- webhooks -------------------------------------------------------------------------------------------------

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<WebhookResult> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
    // Fail secure: with no verifier, nothing is accepted.
    if (!this.o.verifyWebhookSignature || !(await this.o.verifyWebhookSignature(h, rawBody))) return { rejected: 'BAD_SIGNATURE' };
    let b: unknown;
    try {
      b = JSON.parse(rawBody);
    } catch {
      return { rejected: 'MALFORMED' };
    }
    if (!isRecord(b) || !Array.isArray(b['events'])) return { rejected: 'MALFORMED' };
    const events: InboundEvent[] = [];
    for (const e of b['events']) {
      if (!isRecord(e) || typeof e['eventId'] !== 'string' || typeof e['eventType'] !== 'string' || typeof e['timestamp'] !== 'string') return { rejected: 'MALFORMED' };
      const objectRef = objectOf(e);
      events.push({ eventId: e['eventId'], type: e['eventType'], occurredAt: e['timestamp'], ...(objectRef ? { objectRef } : {}) });
    }
    return { events };
  }

  /** Lets a failure inside a paged read surface as a port error. */
  private async *guard<T>(it: AsyncIterable<T>): AsyncGenerator<T> {
    const iterator = it[Symbol.asyncIterator]();
    for (;;) {
      const n = await this.call(() => iterator.next());
      if (n.done) return;
      yield n.value;
    }
  }
}

/** One payment out of a payments response: the object itself, or the first of `payments` / `results`. */
/** Provider cents equal our Money, compared as bigint; anything that is not whole cents never matches. */
function sameCents(v: unknown, m: Money): boolean {
  try {
    return fromCents(v).minor === m.minor;
  } catch {
    return false;
  }
}

function firstItem(data: unknown): Record<string, unknown> {
  if (isRecord(data)) {
    for (const k of ['payments', 'results']) {
      const v = data[k];
      if (Array.isArray(v) && isRecord(v[0])) return v[0];
    }
    return data;
  }
  throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'Crowded answered without a payment');
}

/** The object a webhook event is about, as one of our refs, where it names one. */
function objectOf(e: Record<string, unknown>): string | undefined {
  const ctx = isRecord(e['context']) ? e['context'] : {};
  const data = isRecord(e['data']) ? e['data'] : {};
  const chapter = typeof ctx['chapterId'] === 'string' || typeof ctx['chapterId'] === 'number' ? String(ctx['chapterId']) : typeof data['chapterId'] === 'string' ? data['chapterId'] : undefined;
  const type = String(e['eventType']);
  if (!chapter) return undefined;
  if (type.startsWith('finance.application.')) return chapter;
  const id = data['paymentId'] ?? data['id'];
  return typeof id === 'string' || typeof id === 'number' ? ref(chapter, String(id)) : undefined;
}

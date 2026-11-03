// InstitutionBankingPort simulator (T-0647). A US nonprofit bank in memory. Fixtures choose outcomes by the start of a
// text input, the way the other simulators do:
// - legalName starting `ent_ok` (the default) / `ent_rejected` / `ent_needs_info`: what `decide` settles the
//   application to; `OUTAGE` → PROVIDER_UNAVAILABLE at createEntity.
// - for `holder: 'platform'`, legalName starting `holder_platform_subaccounts` (the default) / `holder_platform_pooled`:
//   whether createSubAccount gives each institution its own account number or one pooled account is shared.
// - funder name starting `pay_ok` (default) / `pay_declined` / `pay_refunded`: how `pay` settles the payment page.
// - counterpartyRef starting `ach_ok` (default) / `ach_returned` / `ach_rejected_201`: how the ACH ends; the last is a
//   create the provider answers with a 201 whose status is Rejected, which the port reports as REJECTED.
// - webhook: `webhook()` signs a batch with `x-webhook-signature: sha256=sim`; `wh_bad_sig` breaks that signature
//   and `wh_dup` repeats the first event id in the batch.
// The panel's hooks: `decide` settles an application, `pay` pays a payment page, `settleAch` finishes a sent ACH,
// `post` posts a transaction on the account, `webhook` builds a signed batch.
import { type Money, money } from '@kesher/domain';
import { type Clock, fixedClock, Sequence } from './base.ts';
import {
  type AchStatus,
  type ApplicationStatus,
  type BankTransaction,
  type CollectedPayment,
  type CollectedPaymentStatus,
  type Funder,
  type Holder,
  type InboundEvent,
  type InstitutionBankingPort,
  InstitutionBankingError,
  type WebhookResult,
  isAddenda,
  requireUsd,
} from './institution-banking.ts';

const SIGNATURE = 'sha256=sim';
const SIG_HEADER = 'x-webhook-signature';
const fail = (code: ConstructorParameters<typeof InstitutionBankingError>[0], message: string): never => {
  throw new InstitutionBankingError(code, message);
};

interface Entity {
  entityRef: string;
  holder: Holder;
  /** A sub-account's platform entity. */
  parent?: string;
  /** A unit of a pooled platform account: it has no account of its own. */
  pooled?: boolean;
  platformMode?: 'subaccounts' | 'pooled';
  fixture: 'ent_ok' | 'ent_rejected' | 'ent_needs_info';
  status: ApplicationStatus;
  balance: bigint;
  accountRef: string;
}
interface Ach {
  paymentRef: string;
  entityRef: string;
  amount: Money;
  status: AchStatus;
  fixture: 'ach_ok' | 'ach_returned';
}
interface Intent {
  intentRef: string;
  collectionRef: string;
  entityRef: string;
  amount: Money;
  fixture: 'pay_ok' | 'pay_declined' | 'pay_refunded';
  payment?: CollectedPayment;
}

export class InstitutionBankingSimulator implements InstitutionBankingPort {
  readonly clock: Clock;
  private readonly pageSize: number;
  private readonly entities = new Map<string, Entity>();
  private readonly collections = new Map<string, { entityRef: string; amount: Money }>();
  private readonly intents = new Map<string, Intent>();
  private readonly payments: (CollectedPayment & { entityRef: string })[] = [];
  private readonly ledger: (BankTransaction & { entityRef: string })[] = [];
  private readonly aches = new Map<string, Ach>();
  private readonly keyed = new Map<string, { body: string; result: unknown }>();
  private readonly ids = { ent: new Sequence('ent'), acct: new Sequence('acct'), sub: new Sequence('sub'), bk: new Sequence('bk'), col: new Sequence('col'), int: new Sequence('int'), pay: new Sequence('pay'), ach: new Sequence('ach'), txn: new Sequence('txn'), ev: new Sequence('ev') };

  /** `pageSize` is the provider's page: small values make the iterators cross page boundaries in tests. */
  constructor(clock: Clock = fixedClock(), pageSize = 100) {
    this.clock = clock;
    this.pageSize = Math.max(1, pageSize);
  }

  /** A create keyed by `key`: the same body answers the same object, another body is IDEMPOTENCY_CONFLICT. */
  private once<T>(scope: string, key: string, body: unknown, make: () => T): T {
    const k = `${scope}:${key}`;
    const text = JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    const prior = this.keyed.get(k);
    if (prior) {
      if (prior.body !== text) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different body');
      return prior.result as T;
    }
    const result = make();
    this.keyed.set(k, { body: text, result });
    return result;
  }

  private entity(ref: string): Entity {
    return this.entities.get(ref) ?? fail('NOT_FOUND', `Unknown entity ${ref}`);
  }
  private approved(ref: string): Entity {
    const e = this.entity(ref);
    if (e.status !== 'approved') fail('NOT_APPROVED', 'The application is not approved');
    if (e.pooled) fail('VALIDATION_FAILED', 'This institution shares the platform account: it has none of its own');
    return e;
  }

  async createEntity(input: { holder: Holder; institutionId: string; legalName: string; ein: string; idempotencyKey: string }): Promise<{ entityRef: string }> {
    if (input.legalName.startsWith('OUTAGE')) fail('PROVIDER_UNAVAILABLE', 'Simulated provider outage');
    if (!input.legalName.trim() || !/^\d{2}-?\d{7}$/.test(input.ein)) fail('VALIDATION_FAILED', 'A legal name and a 9-digit EIN are required');
    return this.once('entity', input.idempotencyKey, input, () => {
      const fixture = input.legalName.startsWith('ent_rejected') ? 'ent_rejected' : input.legalName.startsWith('ent_needs_info') ? 'ent_needs_info' : 'ent_ok';
      const entityRef = this.ids.ent.next();
      const platformMode = input.legalName.startsWith('holder_platform_pooled') ? 'pooled' : 'subaccounts';
      this.entities.set(entityRef, { entityRef, holder: input.holder, ...(input.holder === 'platform' ? { platformMode } : {}), fixture, status: 'pending', balance: 0n, accountRef: this.ids.acct.next() });
      return { entityRef };
    });
  }

  async createSubAccount(input: { entityRef: string; institutionId: string; idempotencyKey: string }): Promise<{ subAccountRef: string; hasOwnAccountNumber: boolean }> {
    const e = this.entity(input.entityRef);
    if (e.holder !== 'platform' || e.parent) fail('VALIDATION_FAILED', 'Only a platform entity has sub-accounts');
    if (e.status !== 'approved') fail('NOT_APPROVED', 'The application is not approved');
    return this.once('sub', input.idempotencyKey, input, () => {
      const pooled = e.platformMode === 'pooled';
      const subAccountRef = this.ids.sub.next();
      this.entities.set(subAccountRef, { entityRef: subAccountRef, holder: 'platform', parent: e.entityRef, pooled, fixture: 'ent_ok', status: 'approved', balance: 0n, accountRef: this.ids.acct.next() });
      return { subAccountRef, hasOwnAccountNumber: !pooled };
    });
  }

  async bookTransfer(input: { fromRef: string; toRef: string; amount: Money; memo: string; idempotencyKey: string }): Promise<{ transferRef: string }> {
    requireUsd(input.amount);
    if (!isAddenda(input.memo)) fail('VALIDATION_FAILED', 'memo must be at most 80 printable ASCII characters');
    const from = this.approved(input.fromRef);
    const to = this.approved(input.toRef);
    if (from.entityRef === to.entityRef) fail('VALIDATION_FAILED', 'A transfer needs two different accounts');
    if (from.holder !== 'platform' || to.holder !== 'platform' || (from.parent ?? from.entityRef) !== (to.parent ?? to.entityRef)) fail('VALIDATION_FAILED', "A book transfer moves money between one platform's own accounts");
    return this.once('book', input.idempotencyKey, input, () => {
      if (from.balance < input.amount.minor) fail('VALIDATION_FAILED', 'Insufficient funds in the account');
      this.post(from.entityRef, 'debit', input.amount, `Book transfer to ${to.entityRef}: ${input.memo}`);
      this.post(to.entityRef, 'credit', input.amount, `Book transfer from ${from.entityRef}: ${input.memo}`);
      return { transferRef: this.ids.bk.next() };
    });
  }

  async startApplication(input: { entityRef: string; applicantIp: string }): Promise<{ formUrl: string }> {
    this.entity(input.entityRef);
    if (!/^[0-9a-f.:]{3,45}$/i.test(input.applicantIp)) fail('VALIDATION_FAILED', 'applicantIp must be an IP address');
    return { formUrl: `https://apply.sim.invalid/${input.entityRef}` };
  }

  async applicationStatus(entityRef: string): Promise<ApplicationStatus> {
    return this.entity(entityRef).status;
  }

  /** Control hook: the provider decides the application, as the entity's fixture says. */
  decide(entityRef: string): ApplicationStatus {
    const e = this.entity(entityRef);
    e.status = e.fixture === 'ent_rejected' ? 'rejected' : e.fixture === 'ent_needs_info' ? 'needs_info' : 'approved';
    return e.status;
  }

  async account(entityRef: string): Promise<{ accountRef: string; balance: Money; last4: string }> {
    const e = this.approved(entityRef);
    return { accountRef: e.accountRef, balance: money(e.balance, 'USD'), last4: '4821' };
  }

  async createCollection(input: { entityRef: string; title: string; amount: Money; idempotencyKey: string }): Promise<{ collectionRef: string }> {
    requireUsd(input.amount);
    this.approved(input.entityRef);
    if (!input.title.trim()) fail('VALIDATION_FAILED', 'A collection needs a title');
    return this.once('collection', input.idempotencyKey, input, () => {
      const collectionRef = this.ids.col.next();
      this.collections.set(collectionRef, { entityRef: input.entityRef, amount: input.amount });
      return { collectionRef };
    });
  }

  async createPaymentPage(input: { collectionRef: string; funder: Funder; idempotencyKey: string }): Promise<{ intentRef: string; paymentUrl: string }> {
    const col = this.collections.get(input.collectionRef) ?? fail('NOT_FOUND', `Unknown collection ${input.collectionRef}`);
    if (!input.funder.name.trim() || !input.funder.email.includes('@') || !/^\+?\d{7,15}$/.test(input.funder.mobile)) fail('VALIDATION_FAILED', 'A funder needs a name, an email and a mobile');
    return this.once('intent', input.idempotencyKey, input, () => {
      const intentRef = this.ids.int.next();
      const name = input.funder.name;
      const fixture = name.startsWith('pay_declined') ? 'pay_declined' : name.startsWith('pay_refunded') ? 'pay_refunded' : 'pay_ok';
      this.intents.set(intentRef, { intentRef, collectionRef: input.collectionRef, entityRef: col.entityRef, amount: col.amount, fixture });
      return { intentRef, paymentUrl: `https://pay.sim.invalid/${intentRef}` };
    });
  }

  /** Control hook: the funder pays the page; the payment settles as the funder's fixture says. Answers the signed webhook batch. */
  pay(intentRef: string): { payment: CollectedPayment; headers: Record<string, string>; rawBody: string } {
    const i = this.intents.get(intentRef) ?? fail('NOT_FOUND', `Unknown payment page ${intentRef}`);
    // A page is paid once: paying it again answers the first payment (and its webhook), never a second credit.
    if (i.payment) return { payment: i.payment, ...this.webhook([{ type: 'collect.payment.' + i.payment.status, objectRef: i.payment.paymentRef }]) };
    const status: CollectedPaymentStatus = i.fixture === 'pay_declined' ? 'declined' : i.fixture === 'pay_refunded' ? 'refunded' : 'paid';
    const payment: CollectedPayment = { paymentRef: this.ids.pay.next(), intentRef, collectionRef: i.collectionRef, amount: i.amount, status, paidAt: this.clock.now() };
    i.payment = payment;
    this.payments.push({ ...payment, entityRef: i.entityRef });
    if (status === 'paid') this.post(i.entityRef, 'credit', i.amount, `Payment ${payment.paymentRef}`);
    return { payment, ...this.webhook([{ type: 'collect.payment.' + status, objectRef: payment.paymentRef }]) };
  }

  async *collectPayments(input: { entityRef: string; since: Date }): AsyncIterable<CollectedPayment> {
    this.approved(input.entityRef);
    const rows = this.payments.filter((p) => p.entityRef === input.entityRef && p.paidAt >= input.since);
    for (let offset = 0; offset < rows.length; offset += this.pageSize) {
      for (const { entityRef: _e, ...p } of rows.slice(offset, offset + this.pageSize)) yield { ...p };
    }
  }

  async quoteAch(input: { entityRef: string; amount: Money }): Promise<{ fee: Money; arrivesOn: string }> {
    requireUsd(input.amount);
    this.approved(input.entityRef);
    const arrives = new Date(this.clock.now().getTime() + 2 * 86_400_000);
    return { fee: money(0n, 'USD'), arrivesOn: arrives.toISOString().slice(0, 10) };
  }

  async sendAch(input: { entityRef: string; counterpartyRef: string; amount: Money; addenda: string; idempotencyKey: string }): Promise<{ paymentRef: string; status: AchStatus }> {
    requireUsd(input.amount);
    if (!isAddenda(input.addenda)) fail('VALIDATION_FAILED', 'addenda must be at most 80 printable ASCII characters');
    const e = this.approved(input.entityRef);
    return this.once('ach', input.idempotencyKey, input, () => {
      if (input.counterpartyRef.startsWith('ach_rejected_201')) fail('REJECTED', 'The provider rejected the payment (201 with status Rejected)');
      if (e.balance < input.amount.minor) fail('VALIDATION_FAILED', 'Insufficient funds in the account');
      const ach: Ach = { paymentRef: this.ids.ach.next(), entityRef: e.entityRef, amount: input.amount, status: 'pending', fixture: input.counterpartyRef.startsWith('ach_returned') ? 'ach_returned' : 'ach_ok' };
      this.aches.set(ach.paymentRef, ach);
      this.post(e.entityRef, 'debit', input.amount, `ACH ${ach.paymentRef}`);
      return { paymentRef: ach.paymentRef, status: ach.status };
    });
  }

  async achStatus(paymentRef: string): Promise<AchStatus> {
    return (this.aches.get(paymentRef) ?? fail('NOT_FOUND', `Unknown payment ${paymentRef}`)).status;
  }

  async cancelAch(paymentRef: string): Promise<AchStatus> {
    const a = this.aches.get(paymentRef) ?? fail('NOT_FOUND', `Unknown payment ${paymentRef}`);
    if (a.status === 'cancelled') return a.status;
    if (a.status !== 'pending') fail('NOT_CANCELLABLE', `A ${a.status} payment cannot be cancelled`);
    a.status = 'cancelled';
    this.post(a.entityRef, 'credit', a.amount, `ACH ${a.paymentRef} cancelled`);
    return a.status;
  }

  /** Control hook: a pending ACH moves on: pending → sent → settled (or returned, for an `ach_returned` counterparty). */
  settleAch(paymentRef: string): AchStatus {
    const a = this.aches.get(paymentRef) ?? fail('NOT_FOUND', `Unknown payment ${paymentRef}`);
    if (a.status === 'pending') a.status = 'sent';
    else if (a.status === 'sent') {
      a.status = a.fixture === 'ach_returned' ? 'returned' : 'settled';
      if (a.status === 'returned') {
        this.post(a.entityRef, 'credit', a.amount, `ACH ${a.paymentRef} returned`);
      }
    }
    return a.status;
  }

  /** Control hook: a transaction posts on the account (a credit adds to the balance, a debit takes from it). */
  post(entityRef: string, kind: 'credit' | 'debit', amount: Money, description: string): BankTransaction {
    requireUsd(amount);
    const e = this.entity(entityRef);
    if (kind === 'debit' && e.balance < amount.minor) fail('VALIDATION_FAILED', 'Insufficient funds in the account');
    e.balance += kind === 'credit' ? amount.minor : -amount.minor;
    const t: BankTransaction & { entityRef: string } = { entityRef, transactionRef: this.ids.txn.next(), kind, amount, postedAt: this.clock.now(), description };
    this.ledger.push(t);
    const { entityRef: _e, ...out } = t;
    return out;
  }

  async *transactions(input: { entityRef: string; from: Date; to: Date }): AsyncIterable<BankTransaction> {
    this.approved(input.entityRef);
    const rows = this.ledger.filter((t) => t.entityRef === input.entityRef && t.postedAt >= input.from && t.postedAt <= input.to);
    for (let offset = 0; offset < rows.length; offset += this.pageSize) {
      for (const { entityRef: _e, ...t } of rows.slice(offset, offset + this.pageSize)) yield { ...t };
    }
  }

  /** Control hook: a signed batch of events. `wh_bad_sig` breaks the signature; `wh_dup` repeats the first event id. */
  webhook(events: { type: string; objectRef?: string }[], fixture?: 'wh_bad_sig' | 'wh_dup'): { headers: Record<string, string>; rawBody: string } {
    const batch: InboundEvent[] = events.map((e) => ({ eventId: this.ids.ev.next(), type: e.type, ...(e.objectRef ? { objectRef: e.objectRef } : {}), occurredAt: this.clock.now().toISOString() }));
    if (fixture === 'wh_dup' && batch[0]) batch.push({ ...batch[0] });
    return { headers: { [SIG_HEADER]: fixture === 'wh_bad_sig' ? 'sha256=forged' : SIGNATURE }, rawBody: JSON.stringify({ events: batch }) };
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<WebhookResult> {
    if (headers[SIG_HEADER] !== SIGNATURE) return { rejected: 'BAD_SIGNATURE' };
    let b: { events?: unknown };
    try {
      b = JSON.parse(rawBody) as typeof b;
    } catch {
      return { rejected: 'MALFORMED' };
    }
    if (!Array.isArray(b.events)) return { rejected: 'MALFORMED' };
    const events: InboundEvent[] = [];
    for (const e of b.events as Record<string, unknown>[]) {
      if (typeof e?.['eventId'] !== 'string' || typeof e['type'] !== 'string' || typeof e['occurredAt'] !== 'string') return { rejected: 'MALFORMED' };
      events.push({ eventId: e['eventId'], type: e['type'], occurredAt: e['occurredAt'], ...(typeof e['objectRef'] === 'string' ? { objectRef: e['objectRef'] } : {}) });
    }
    return { events };
  }
}

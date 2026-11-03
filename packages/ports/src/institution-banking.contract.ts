// InstitutionBankingPort contract (T-0647, REQ-INS-022..026). Every adapter:
// - creates an entity (an institution's own, or the platform's) once per idempotency key, and refuses a reused key with another body (IDEMPOTENCY_CONFLICT);
// - keeps money features closed until the application is approved (NOT_APPROVED), and returns the account's last
//   four digits and a USD balance in bigint, never the number;
// - refuses any currency but USD, and an ACH addenda over 80 characters or outside printable ASCII, before the provider;
// - makes one payment page per key, and lists each collected payment once, across pages;
// - sends one ACH per key, cancels it only while it has not been sent, and reports its status;
// - lists the account's transactions each exactly once, across pages;
// - for a platform entity: makes one sub-account per key, and either gives it an account of its own (it can then be
//   moved to by book transfer, once per key, never overdrawing) or says it shares the pooled account (nothing is
//   booked at the bank); an institution's own entity has no sub-accounts;
// - verifies a webhook batch (a bad signature or body is a rejection, not an exception) and surfaces outages as
//   PROVIDER_UNAVAILABLE.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { type Holder, InstitutionBankingError, type InstitutionBankingPort } from './institution-banking.ts';

export interface InstitutionBankingContractOptions<P extends InstitutionBankingPort> {
  /** Which holder setup the suite runs under; a platform adapter runs it again for each way the provider can be set up. */
  holder: Holder;
  /** The legal name the entities are created with (a provider fixture or setup can ride on it). */
  legalName?: string;
  /** The provider decides the entity's application: approved. */
  approve(port: P, entityRef: string): Promise<void>;
  /** Puts money in the entity's account (USD minor units). */
  fund(port: P, entityRef: string, minor: bigint): Promise<void>;
  /** Posts `count` transactions on the entity's account. */
  post(port: P, entityRef: string, count: number): Promise<void>;
  /** A funder pays a payment page; answers the provider's signed webhook for it. */
  pay(port: P, intentRef: string): Promise<{ headers: Record<string, string>; rawBody: string }>;
  /** A pending ACH moves on one step (pending → sent). */
  advanceAch(port: P, paymentRef: string): Promise<void>;
  /** A signed batch of events, and the same with its signature broken the way this provider signs. */
  signed(port: P): { headers: Record<string, string>; rawBody: string };
  forge(n: { headers: Record<string, string>; rawBody: string }): { headers: Record<string, string>; rawBody: string };
  /** A legal name the provider can be made unavailable for, where one can be forced. */
  outageLegalName?: string;
}

const SINCE = new Date('2026-01-01T00:00:00Z');
const UNTIL = new Date('2027-01-01T00:00:00Z');

export function institutionBankingContract<P extends InstitutionBankingPort>(name: string, make: () => P, opts: InstitutionBankingContractOptions<P>): void {
  const NEW = (key: string, legalName = opts.legalName ?? 'American Friends of Yeshiva Or') => ({ holder: opts.holder, institutionId: '0190a0a0-0000-7000-8000-000000000001', legalName, ein: '12-3456789', idempotencyKey: key });
  const approved = async (port: P, key = 'key-entity-0001'): Promise<string> => {
    const { entityRef } = await port.createEntity(NEW(key));
    await port.startApplication({ entityRef, applicantIp: '203.0.113.7' });
    await opts.approve(port, entityRef);
    return entityRef;
  };

  describe(`InstitutionBankingPort contract: ${name}`, () => {
    it('creates an entity once per key; another body on the same key is IDEMPOTENCY_CONFLICT', async () => {
      const port = make();
      const a = await port.createEntity(NEW('key-entity-0001'));
      expect(await port.createEntity(NEW('key-entity-0001'))).toEqual(a);
      await expect(port.createEntity(NEW('key-entity-0001', 'Another Name'))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect((await port.createEntity(NEW('key-entity-0002'))).entityRef).not.toBe(a.entityRef);
    });

    it('keeps the account closed until approved; then last four and a USD balance in bigint', async () => {
      const port = make();
      const { entityRef } = await port.createEntity(NEW('key-entity-0001'));
      expect(await port.applicationStatus(entityRef)).toBe('pending');
      expect((await port.startApplication({ entityRef, applicantIp: '203.0.113.7' })).formUrl).toMatch(/^https:\/\//);
      await expect(port.account(entityRef)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
      await expect(port.createCollection({ entityRef, title: 'Trip', amount: money(10_000n, 'USD'), idempotencyKey: 'key-col-00001' })).rejects.toMatchObject({ code: 'NOT_APPROVED' });
      await opts.approve(port, entityRef);
      expect(await port.applicationStatus(entityRef)).toBe('approved');
      await opts.fund(port, entityRef, 123_456n);
      const acct = await port.account(entityRef);
      expect(acct.last4).toMatch(/^\d{4}$/);
      expect(acct.balance).toEqual(money(123_456n, 'USD'));
      expect(typeof acct.balance.minor).toBe('bigint');
    });

    it('refuses any currency but USD, and a bad addenda, before the provider is called', async () => {
      const port = make();
      const entityRef = await approved(port);
      await expect(port.createCollection({ entityRef, title: 'Trip', amount: money(10_000n, 'ILS'), idempotencyKey: 'key-col-00001' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.quoteAch({ entityRef, amount: money(10_000n, 'ILS') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const send = (addenda: string, minor = 10_000n, currency: 'USD' | 'ILS' = 'USD') => port.sendAch({ entityRef, counterpartyRef: 'cp_kesher', amount: money(minor, currency), addenda, idempotencyKey: `key-ach-${addenda.length}-${currency}` });
      await opts.fund(port, entityRef, 100_000n);
      await expect(send('KC-7M4QX2HD', 10_000n, 'ILS')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(send('x'.repeat(81))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(send('KC-שלום')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(send('KC-7M4QX2HD', 0n)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(send('x'.repeat(80))).resolves.toMatchObject({ paymentRef: expect.any(String) });
    });

    it('makes one payment page per key and lists each collected payment once', async () => {
      const port = make();
      const entityRef = await approved(port);
      const { collectionRef } = await port.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
      const funder = (n: number) => ({ name: `Funder ${n}`, email: `f${n}@example.com`, mobile: '+12125550123' });
      const page = await port.createPaymentPage({ collectionRef, funder: funder(0), idempotencyKey: 'key-page-0000' });
      expect(page.paymentUrl).toMatch(/^https:\/\//);
      expect(await port.createPaymentPage({ collectionRef, funder: funder(0), idempotencyKey: 'key-page-0000' })).toEqual(page);
      const intents = [page.intentRef];
      for (let n = 1; n < 5; n++) intents.push((await port.createPaymentPage({ collectionRef, funder: funder(n), idempotencyKey: `key-page-000${n}` })).intentRef);
      for (const intentRef of intents) {
        const hook = await opts.pay(port, intentRef);
        const parsed = await port.parseWebhook(hook.headers, hook.rawBody);
        expect('events' in parsed && parsed.events.length).toBeGreaterThan(0);
      }
      const seen: string[] = [];
      for await (const p of port.collectPayments({ entityRef, since: SINCE })) {
        expect(typeof p.amount.minor).toBe('bigint');
        seen.push(p.paymentRef);
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('sends one ACH per key, cancels only before it is sent, and reports its status', async () => {
      const port = make();
      const entityRef = await approved(port);
      await opts.fund(port, entityRef, 500_000n);
      const q = await port.quoteAch({ entityRef, amount: money(120_000n, 'USD') });
      expect(q.fee.currency).toBe('USD');
      if (q.arrivesOn !== undefined) expect(q.arrivesOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const input = { entityRef, counterpartyRef: 'cp_kesher', amount: money(120_000n, 'USD'), addenda: 'KC-7M4QX2HD', idempotencyKey: 'key-ach-00001' };
      const a = await port.sendAch(input);
      expect(await port.sendAch(input)).toEqual(a);
      await expect(port.sendAch({ ...input, amount: money(1n, 'USD') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(await port.achStatus(a.paymentRef)).toBe(a.status);
      expect(await port.cancelAch(a.paymentRef)).toBe('cancelled');
      expect(await port.achStatus(a.paymentRef)).toBe('cancelled');
      const b = await port.sendAch({ ...input, idempotencyKey: 'key-ach-00002' });
      await opts.advanceAch(port, b.paymentRef);
      await expect(port.cancelAch(b.paymentRef)).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });
      await expect(port.achStatus('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists the account\'s transactions each exactly once, across pages', async () => {
      const port = make();
      const entityRef = await approved(port);
      await opts.post(port, entityRef, 5);
      const refs: string[] = [];
      for await (const t of port.transactions({ entityRef, from: SINCE, to: UNTIL })) {
        expect(t.amount.minor > 0n).toBe(true);
        expect(['credit', 'debit']).toContain(t.kind);
        refs.push(t.transactionRef);
      }
      expect(refs).toHaveLength(5);
      expect(new Set(refs).size).toBe(5);
    });

    it.skipIf(opts.holder !== 'institution')('gives an institution\'s own entity no sub-accounts', async () => {
      const port = make();
      const entityRef = await approved(port);
      await expect(port.createSubAccount({ entityRef, institutionId: '0190a0a0-0000-7000-8000-000000000002', idempotencyKey: 'key-sub-00001' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it.skipIf(opts.holder !== 'platform')('makes one sub-account per key, and only for an approved platform entity', async () => {
      const port = make();
      const { entityRef } = await port.createEntity(NEW('key-entity-0001'));
      const inst = (n: number) => `0190a0a0-0000-7000-8000-00000000010${n}`;
      await expect(port.createSubAccount({ entityRef, institutionId: inst(1), idempotencyKey: 'key-sub-00001' })).rejects.toMatchObject({ code: 'NOT_APPROVED' });
      await port.startApplication({ entityRef, applicantIp: '203.0.113.7' });
      await opts.approve(port, entityRef);
      const a = await port.createSubAccount({ entityRef, institutionId: inst(1), idempotencyKey: 'key-sub-00001' });
      expect(typeof a.hasOwnAccountNumber).toBe('boolean');
      expect(await port.createSubAccount({ entityRef, institutionId: inst(1), idempotencyKey: 'key-sub-00001' })).toEqual(a);
      await expect(port.createSubAccount({ entityRef, institutionId: inst(2), idempotencyKey: 'key-sub-00001' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect((await port.createSubAccount({ entityRef, institutionId: inst(2), idempotencyKey: 'key-sub-00002' })).subAccountRef).not.toBe(a.subAccountRef);
    });

    it.skipIf(opts.holder !== 'platform')('books money between the platform\'s own accounts once per key, or says the account is shared', async () => {
      const port = make();
      const entityRef = await approved(port);
      await opts.fund(port, entityRef, 500_000n);
      const sub = await port.createSubAccount({ entityRef, institutionId: '0190a0a0-0000-7000-8000-000000000101', idempotencyKey: 'key-sub-00001' });
      const book = (minor: bigint, key: string, memo = 'KC-7M4QX2HD', currency: 'USD' | 'ILS' = 'USD') => port.bookTransfer({ fromRef: entityRef, toRef: sub.subAccountRef, amount: money(minor, currency), memo, idempotencyKey: key });
      if (!sub.hasOwnAccountNumber) {
        await expect(book(120_000n, 'key-book-0001')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        await expect(port.account(sub.subAccountRef)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        return;
      }
      const t = await book(120_000n, 'key-book-0001');
      expect(await book(120_000n, 'key-book-0001')).toEqual(t);
      await expect(book(1n, 'key-book-0001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect((await port.account(sub.subAccountRef)).balance).toEqual(money(120_000n, 'USD'));
      expect((await port.account(entityRef)).balance).toEqual(money(380_000n, 'USD'));
      await expect(book(380_001n, 'key-book-0002')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(book(1n, 'key-book-0003', 'KC-שלום')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(book(1n, 'key-book-0004', 'KC-7M4QX2HD', 'ILS')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.bookTransfer({ fromRef: entityRef, toRef: entityRef, amount: money(1n, 'USD'), memo: 'KC-7M4QX2HD', idempotencyKey: 'key-book-0005' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await port.account(entityRef)).balance).toEqual(money(380_000n, 'USD'));
    });

    it('verifies a webhook batch; a forged or malformed one is a rejection, not an exception', async () => {
      const port = make();
      const n = opts.signed(port);
      const ok = await port.parseWebhook(n.headers, n.rawBody);
      expect(ok).toHaveProperty('events');
      if (!('events' in ok)) throw new Error('a signed batch was rejected');
      expect(ok.events.length).toBeGreaterThan(0);
      for (const e of ok.events) expect(e).toMatchObject({ eventId: expect.any(String), type: expect.any(String), occurredAt: expect.any(String) });
      const f = opts.forge(n);
      expect(await port.parseWebhook(f.headers, f.rawBody)).toEqual({ rejected: 'BAD_SIGNATURE' });
      expect(await port.parseWebhook(n.headers, 'not json')).toEqual({ rejected: 'MALFORMED' });
    });

    it.skipIf(!opts.outageLegalName)('surfaces an outage as PROVIDER_UNAVAILABLE', async () => {
      const e = await make().createEntity(NEW('key-entity-0001', opts.outageLegalName)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(InstitutionBankingError);
      expect(e).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });
  });
}

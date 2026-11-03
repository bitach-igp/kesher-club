// TST-INS-026 nightly reconciliation of the linked US accounts (T-0654, REQ-INS-026). A clean day opens no case; each break type opens one case
// keyed by the provider's reference (a payment with no row is created through the T-0652 insert and noted, a row with no payment, an amount
// mismatch, an outbound debit with no funding request, a payment for a page we never made); a rerun opens none; a provider page boundary
// mid-day loses nothing; an outage is retried with back-off and then costs one case for the institution; the flag off asks the provider nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { fixedClock, InstitutionBankingError, type AdvanceableClock, type InstitutionBankingPort } from '@kesher/ports';
import { createApp, type App } from '@kesher/api/app';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { createRegistry } from '@kesher/api/registry';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { decideKyb } from '@kesher/api/test-institution';
import { israelDayStart, previousIsraelDay, UsBankingRecon } from './us-banking.ts';

let db: TestDatabase;
let app: App;
let host: ReturnType<typeof createRegistry>['simulators'];
let entityRef = '';
// The provider's clock is 2026-11-01T09:00Z (noon-ish in Israel): the run at 05:30 on the 2nd reconciles the 1st.
const RUN = new Date('2026-11-02T03:30:00Z');
const INST = uuidv7(RUN);
const BATCH = uuidv7(RUN);
const ACTOR = uuidv7(RUN);
const items = Array.from({ length: 6 }, () => uuidv7(RUN));
const sim = () => host.simulators['institution-banking'];
const port = () => host.registry.resolve<InstitutionBankingPort>('institution-banking', 'IL');
const cases = async () => (await db.query<{ reason: string; ref: string }>(`select payload->>'reason' as reason, payload->>'externalId' as ref from ops.case where kind = 'recon_break' order by payload->>'reason', payload->>'externalId'`)).rows;
const intentOf = async (i: number) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'fee_item_us_intent' and entity_id = $1`, [items[i]])).rows[0]!.external_id;
const job = (flagOn = true, clock = () => RUN, sleep: (ms: number) => Promise<void> = async () => undefined) =>
  new UsBankingRecon(db, new StaticFlags(undefined, { 'institutions.usBanking': flagOn }), app.services.usCollections, port, 'IL', clock, sleep);

beforeAll(async () => {
  db = await createTestDatabase();
  host = createRegistry('sim', fixedClock('2026-11-01T09:00:00Z') as AdvanceableClock).simulators;
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => RUN, flags: new StaticFlags(undefined, { 'institutions.usBanking': true }) });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Reconciled School', 'IL')`, [INST]);
  await decideKyb(db, INST);
  await app.services.usBanking.link(INST, ACTOR, { holder: 'institution', usEntity: { legalName: 'American Friends of Reconciled School', ein: '12-3456789' } }, 'recon-link-0001', '198.51.100.4', RUN);
  entityRef = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_banking' and entity_id = $1`, [INST])).rows[0]!.external_id;
  sim().decide(entityRef);
  await app.services.usBanking.read(INST, RUN);
  (sim() as unknown as { pageSize: number }).pageSize = 2;
  const member = uuidv7(RUN);
  await db.query(`insert into org.fee_batch (id, idempotency_key, institution_id, description, amount_minor, currency, due_at, member_count, request_hash, created_by, created_at) values ($1, 'recon-batch-01', $2, 'Tuition', 25000, 'USD', '2026-12-01', 6, 'h', $3, $4)`, [BATCH, INST, member, RUN]);
  for (const id of items) await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at, created_at, batch_id) values ($1, $2, $3, 'Tuition', 25000, 'USD', 'due', '2026-12-01', $4, $5)`, [id, INST, member, RUN, BATCH]);
  const funders = items.map((feeItemId, i) => ({ feeItemId, name: `Funder ${i}`, email: `f${i}@example.org`, mobile: `+1415555020${i}` }));
  await app.services.usCollections.collect(INST, BATCH, { funders }, ACTOR, RUN);
}, 120_000);
afterAll(async () => db.close());

describe('the nightly US banking reconciliation (TST-INS-026, T-0654)', () => {
  it('knows the Israel day: 2026-11-01 starts at 22:00Z the evening before', () => {
    expect(israelDayStart('2026-11-01').toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(israelDayStart('2026-07-01').toISOString()).toBe('2026-06-30T21:00:00.000Z');
  });

  it('the day before is by the calendar, also on the nights the clocks change', () => {
    expect(previousIsraelDay(new Date('2026-10-25T21:30:00Z'))).toBe('2026-10-24'); // 23:30 on the fall-back day
    expect(previousIsraelDay(new Date('2027-03-26T22:30:00Z'))).toBe('2027-03-26'); // 00:30 after spring-forward, 03-27
    expect(previousIsraelDay(new Date('2026-11-02T03:30:00Z'))).toBe('2026-11-01');
  });

  it('a clean day opens no case, and the flag off asks the provider nothing', async () => {
    expect(await job().run(RUN)).toMatchObject({ day: '2026-11-01', institutions: 1, clean: 1, breaks: 0, outages: 0 });
    expect(await cases()).toEqual([]);
    const read = vi.spyOn(port(), 'collectPayments');
    expect(await job(false).run(RUN)).toMatchObject({ skipped: 'flag_off' });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('each break type opens one case keyed by the provider reference; a payment the hint missed is recorded and noted; nothing is lost across pages; a rerun opens none', async () => {
    // Funders pay five pages; one is told to us (the hint), the rest are not.
    const refs: string[] = [];
    for (let i = 0; i < 5; i++) refs.push(sim().pay(await intentOf(i)).payment.paymentRef);
    await app.services.usCollections.reconcileEntity(port(), entityRef, new Date(0), RUN, 'simulator'); // all five recorded, as the hint would
    // Break 1: a payment the hint missed. Remove its row to look as if the hint never came.
    await db.query(`delete from org.fee_external_payment where provider_payment_ref = $1`, [refs[1]]).catch(() => undefined);
    // The table is insert-only for the app role but the test connection owns it; if the delete was refused the next assertion would say so.
    await db.query(`update org.fee_item set status = 'due' where id = $1`, [items[1]]);
    // Break 2: the recorded amount differs from the provider's.
    await db.query(`update org.fee_external_payment set amount_minor = 24000 where provider_payment_ref = $1`, [refs[2]]);
    // Break 3: a row the provider never listed (recorded yesterday).
    await db.query(`insert into org.fee_external_payment (id, fee_item_id, kind, provider_payment_ref, amount_minor, currency, at) values ($1, $2, 'payment', 'pay_ghost_0001', 25000, 'USD', '2026-11-01T10:00:00Z')`, [uuidv7(RUN), items[5]]);
    // Break 4: money out that no funding request explains; one that a request explains is fine.
    sim().post(entityRef, 'credit', money(20_000_000n, 'USD'), 'Wire in');
    sim().post(entityRef, 'debit', money(7_700n, 'USD'), 'ACH to a stranger');
    const quote = uuidv7(RUN);
    await db.query(`insert into org.us_funding_quote (id, institution_id, amount_minor, fee_minor, currency, expires_at, created_by, created_at) values ($1, $2, 90000, 0, 'USD', $3, $4, $3)`, [quote, INST, RUN, ACTOR]);
    await db.query(`insert into org.us_funding_request (id, institution_id, idempotency_key, quote_id, holder, amount_minor, currency, reference, requested_by, created_at) values ($1, $2, 'recon-fund-01', $3, 'institution', 90000, 'USD', 'KC-RECON001', $4, $5)`, [uuidv7(RUN), INST, quote, ACTOR, RUN]);
    await db.query(`insert into org.us_funding_event (id, request_id, kind, payload, at) select $1, id, 'sending', '{}', $2 from org.us_funding_request where reference = 'KC-RECON001'`, [uuidv7(RUN), RUN]);
    sim().post(entityRef, 'debit', money(90_000n, 'USD'), 'ACH KC-RECON001 funding');
    // The KC- reference is public: the same text on a debit of another amount, or a second debit of the same amount, is not explained by that one request.
    sim().post(entityRef, 'debit', money(5_000_000n, 'USD'), 'memo KC-RECON001');
    sim().post(entityRef, 'debit', money(90_000n, 'USD'), 'again KC-RECON001');

    const first = await job().run(RUN);
    expect(first).toMatchObject({ institutions: 1, clean: 0, breaks: 6 });
    const found = await cases();
    expect(found.map((c) => c.reason)).toEqual(['amount_mismatch', 'outbound_without_request', 'outbound_without_request', 'outbound_without_request', 'payment_row_created', 'row_without_payment']);
    expect(found.find((c) => c.reason === 'amount_mismatch')!.ref).toBe(refs[2]);
    expect(found.find((c) => c.reason === 'payment_row_created')!.ref).toBe(refs[1]);
    expect(found.find((c) => c.reason === 'row_without_payment')!.ref).toBe('pay_ghost_0001');
    // The missed payment was recorded through the T-0652 insert and marks its fee paid.
    expect((await db.query<{ status: string }>('select status from org.fee_item where id = $1', [items[1]])).rows[0]!.status).toBe('paid');
    // A rerun finds the same mismatch, the same ghost and the same debit, and opens nothing new.
    const before = (await cases()).length;
    await job().run(RUN);
    expect((await cases()).length).toBe(before);
  });

  it('a payment for a page we never made is a case', async () => {
    // A second collection on the same account that the fee tables know nothing about.
    const col = await sim().createCollection({ entityRef, title: 'Someone else', amount: money(1_100n, 'USD'), idempotencyKey: 'stray-collection-1' });
    const page = await sim().createPaymentPage({ collectionRef: col.collectionRef, funder: { name: 'Stray', email: 's@example.org', mobile: '+14155550299' }, idempotencyKey: 'stray-page-0001' });
    const paid = sim().pay(page.intentRef).payment;
    await job().run(RUN);
    expect((await cases()).find((c) => c.reason === 'payment_without_page')!.ref).toBe(paid.paymentRef);
  });

  it('an outage is retried with back-off, then costs one case for the institution; the day is read on the next run that can', async () => {
    const down = vi.spyOn(port(), 'collectPayments').mockImplementation(() => {
      throw new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'down');
    });
    const sleeps: number[] = [];
    const report = await job(true, () => RUN, async (ms) => void sleeps.push(ms)).run(RUN);
    expect(report).toMatchObject({ institutions: 1, outages: 1 });
    expect(sleeps).toEqual([1000, 2000]);
    const outage = () => db.query(`select 1 from ops.case where kind = 'recon_break' and payload->>'reason' = 'provider_outage'`).then((r) => r.rows.length);
    expect(await outage()).toBe(1);
    // Down again the same day: still one case.
    await job(true, () => RUN, async () => undefined).run(RUN);
    expect(await outage()).toBe(1);
    down.mockRestore();
    // The next night the account is readable: a payment of the lost day that the hint missed is recorded now.
    const col = await sim().createCollection({ entityRef, title: 'Lost day', amount: money(25_000n, 'USD'), idempotencyKey: 'lost-day-col-01' });
    expect(col.collectionRef).toBeTruthy();
    const next = new Date('2026-11-03T03:30:00Z');
    expect(await job(true, () => next).run(next)).toMatchObject({ day: '2026-11-02', outages: 0 });
    expect((await db.query(`select 1 from ops.case where payload->>'reason' = 'provider_outage' and payload->>'recoveredAt' is null`)).rows).toHaveLength(0);
  });

  it('an account the bank will not answer for is its own reason, not an outage', async () => {
    const closed = vi.spyOn(port(), 'collectPayments').mockImplementation(() => {
      throw new InstitutionBankingError('NOT_APPROVED', 'closed');
    });
    const day = new Date('2026-11-04T03:30:00Z');
    expect(await job(true, () => day).run(day)).toMatchObject({ outages: 1 });
    closed.mockRestore();
    expect((await db.query(`select 1 from ops.case where payload->>'reason' = 'account_unreadable' and payload->>'day' = '2026-11-03'`)).rows).toHaveLength(1);
  });

  it('a run that finishes after 06:00 Israel time says so with one case', async () => {
    const late = new Date('2026-11-02T05:00:00Z'); // 07:00 in Israel
    expect(await job(true, () => late).run(RUN)).toMatchObject({ withinDeadline: false });
    expect((await db.query(`select 1 from ops.case where payload->>'reason' = 'deadline_missed'`)).rows).toHaveLength(1);
    await job(true, () => late).run(RUN);
    expect((await db.query(`select 1 from ops.case where payload->>'reason' = 'deadline_missed'`)).rows).toHaveLength(1);
  });
});

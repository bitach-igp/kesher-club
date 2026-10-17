// T-0303: dunning, pause/resume, and the 10-month term. Driven by BillingPort webhooks
// (invoice.payment_failed / invoice.paid) with retries at days 3, 5, 7 then pause; resume after a
// successful payment; the term ends after 10 monthly invoices (cancel at period end).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, NotifySimulator } from '@kesher/ports';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { DUNNING_SCHEDULE_DAYS, DunningService, termEnd } from './dunning.ts';

let db: TestDatabase;
let plans: PlanService;
let memberships: MembershipService;
let billing: BillingSimulator;
let notify: NotifySimulator;
let dunning: DunningService;
const t0 = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  plans = new PlanService(db);
  billing = new BillingSimulator();
  notify = new NotifySimulator();
  memberships = new MembershipService(db, plans, billing);
  dunning = new DunningService(db, memberships, billing, notify);
  await plans.ensurePlan('club', 'Club');
  await plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
}, 60_000);
afterAll(async () => db.close());

async function activeMembership(email = 'funder@example.com') {
  const m = await memberships.create({ idempotencyKey: `m-${uuidv7()}`, memberPartyId: uuidv7(), funderPartyId: uuidv7(), funderEmail: email, planCode: 'club' }, t0);
  const sub = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'membership' and entity_id = $1`, [m.id])).rows[0]!.external_id;
  return { m, sub };
}

const failed = (sub: string, attempt: number) => billing.webhookFor(sub, 'invoice.payment_failed', attempt);
const paid = (sub: string) => billing.webhookFor(sub, 'invoice.paid');

describe('dunning', () => {
  it('first failure: membership past_due, funder emailed, next retry scheduled at +3 days', async () => {
    const { m, sub } = await activeMembership();
    const hook = failed(sub, 1);
    const r = await dunning.onBillingEvent(await billing.parseWebhook(hook.headers, hook.rawBody), t0);
    expect(r).toMatchObject({ membershipId: m.id, status: 'past_due', attempt: 1, nextRetryAt: new Date(t0.getTime() + DUNNING_SCHEDULE_DAYS[0]! * 86_400_000).toISOString() });
    expect((await memberships.get(m.id))!.status).toBe('past_due');
    expect(notify.sent.at(-1)).toMatchObject({ channel: 'email', template: 'billing.payment_failed', category: 'money', data: expect.objectContaining({ attempt: '1', retryDays: '3' }) });
  });

  it('after the third failure the membership is paused at the vendor and the funder told how to resume', async () => {
    const { m, sub } = await activeMembership();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const hook = failed(sub, attempt);
      await dunning.onBillingEvent(await billing.parseWebhook(hook.headers, hook.rawBody), new Date(t0.getTime() + attempt * 86_400_000));
    }
    expect((await memberships.get(m.id))!.status).toBe('paused');
    expect((await billing.get(sub)).status).toBe('paused');
    expect(notify.sent.at(-1)).toMatchObject({ template: 'billing.paused' });
  });

  it('a successful invoice resumes a paused membership and resets the dunning counter', async () => {
    const { m, sub } = await activeMembership();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const hook = failed(sub, attempt);
      await dunning.onBillingEvent(await billing.parseWebhook(hook.headers, hook.rawBody), t0);
    }
    const hook = paid(sub);
    const r = await dunning.onBillingEvent(await billing.parseWebhook(hook.headers, hook.rawBody), t0);
    expect(r.status).toBe('active');
    const after = await memberships.get(m.id);
    expect(after!.status).toBe('active');
    expect(after!.dunningAttempts).toBe(0);
    expect((await billing.get(sub)).status).toBe('active');
  });

  it('a manual pause and resume by the funder go through the vendor and keep entitlements consistent', async () => {
    const { m, sub } = await activeMembership();
    expect((await dunning.pause(m.id, 'funder request', t0)).status).toBe('paused');
    expect((await billing.get(sub)).status).toBe('paused');
    expect((await dunning.resume(m.id, t0)).status).toBe('active');
    await expect(dunning.resume(m.id, t0)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('the 10-month term ends with a cancel at period end after the 10th paid invoice', async () => {
    const { m, sub } = await activeMembership();
    for (let i = 1; i <= 9; i++) {
      const hook = paid(sub);
      await dunning.onBillingEvent(await billing.parseWebhook(hook.headers, hook.rawBody), t0);
    }
    expect((await billing.get(sub)).cancelAt).toBeUndefined();
    const hook = paid(sub);
    const r = await dunning.onBillingEvent(await billing.parseWebhook(hook.headers, hook.rawBody), t0);
    expect(r.paidInvoices).toBe(10);
    expect((await billing.get(sub)).cancelAt).toBeTruthy();
    expect(termEnd(m.createdAt, 10)).toBe('2027-09-01T10:00:00.000Z');
    expect(notify.sent.at(-1)).toMatchObject({ template: 'billing.term_complete' });
  });

  it('is idempotent per event id: the same failed-invoice webhook twice counts one attempt', async () => {
    const { m, sub } = await activeMembership();
    const hook = failed(sub, 1);
    const e = await billing.parseWebhook(hook.headers, hook.rawBody);
    await dunning.onBillingEvent(e, t0);
    await dunning.onBillingEvent(e, t0);
    expect((await memberships.get(m.id))!.dunningAttempts).toBe(1);
  });
});

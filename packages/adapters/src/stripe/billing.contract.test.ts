// StripeBillingAdapter passes billingContract against the in-memory fake Stripe; the same file runs
// against the Stripe sandbox nightly when STRIPE_SANDBOX_SECRET_KEY is present (T-0301).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { billingContract } from '@kesher/ports/contracts';
import { StripeBillingAdapter } from './billing.ts';
import { FakeStripe } from './fake-stripe.ts';

const secretKey = 'sk_test_fake_key';
const webhookSecret = 'whsec_fake_signing_secret';

function harness(clock: AdvanceableClock = fixedClock() as AdvanceableClock) {
  const fake = new FakeStripe({ secretKey, webhookSecret, clock });
  const port = new StripeBillingAdapter({ secretKey, webhookSecret, planProducts: { club: 'prod_club' }, fetch: fake.fetch, clock });
  return { fake, port };
}

const fakes = new WeakMap<object, FakeStripe>();
const make = () => {
  const h = harness();
  fakes.set(h.port, h.fake);
  return h.port;
};

billingContract('stripe', make, {
  failedInvoiceWebhook: async (port, subscriptionId) => fakes.get(port)!.failInvoice(subscriptionId),
  declinedEmail: 'nope@declined.example',
  outageEmail: 'x@outage.example',
});

describe('StripeBillingAdapter specifics', () => {
  const price = money(4900n, 'USD');

  it('sends Stripe an Idempotency-Key and a 10-month cancel_at, and locks the plan price inline', async () => {
    const clock = fixedClock('2026-09-01T09:00:00Z') as AdvanceableClock;
    const { fake, port } = harness(clock);
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'cust-key');
    const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 'sub-key');
    const call = fake.calls.find((x) => x.path === '/v1/subscriptions' && x.method === 'POST')!;
    expect(call.idempotencyKey).toBe('sub-key');
    expect(call.form['cancel_at']).toBe(String(Math.floor(Date.UTC(2027, 6, 1, 9) / 1000)));
    expect(call.form['payment_behavior']).toBe('error_if_incomplete');
    const item = (call.form['items'] as Record<string, Record<string, string>>[])[0]!;
    expect(item['price_data']).toMatchObject({ currency: 'usd', unit_amount: '4900', product: 'prod_club' });
    expect(s.termMonths).toBe(10);
    expect(s.cancelAt).toBeUndefined(); // the term end is not a member cancellation
  });

  it('unknown plan codes never reach Stripe', async () => {
    const { fake, port } = harness();
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'k1');
    await expect(port.createSubscription({ customerId: c.customerId, planCode: 'gold', price, termMonths: 10 }, 'k2')).rejects.toMatchObject({ code: 'UNKNOWN_PLAN' });
    expect(fake.calls.filter((x) => x.path === '/v1/subscriptions')).toHaveLength(0);
  });

  it('maps wallet flags onto the SetupIntent the Payment Element will read', async () => {
    const { fake, port } = harness();
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'k1');
    const sheet = await port.createSetupSheet(c.customerId, { applePay: true, googlePay: false });
    expect(sheet.wallets).toEqual({ applePay: true, googlePay: false });
    const call = fake.calls.find((x) => x.path === '/v1/setup_intents')!;
    expect(call.form['metadata']).toEqual({ applePay: 'auto', googlePay: 'never' });
    expect(call.form['customer']).toBe(c.customerId);
    await expect(port.createSetupSheet('cus_nope', { applePay: true, googlePay: true })).rejects.toMatchObject({ code: 'UNKNOWN_CUSTOMER' });
  });

  it('cancel now goes through DELETE and reports cancelled; a second cancel is INVALID_STATE', async () => {
    const { fake, port } = harness();
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'k1');
    const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 'k2');
    const cancelled = await port.cancel(s.subscriptionId, 'now', 'k3');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelAt).toBeTruthy();
    expect(fake.calls.some((x) => x.method === 'DELETE' && x.path === `/v1/subscriptions/${s.subscriptionId}`)).toBe(true);
    await expect(port.cancel(s.subscriptionId, 'now', 'k4')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(port.pause(s.subscriptionId, 'k5')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('pause uses pause_collection and resume clears it', async () => {
    const { fake, port } = harness();
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'k1');
    const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 'k2');
    await port.pause(s.subscriptionId, 'k3');
    await expect(port.pause(s.subscriptionId, 'k3b')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await port.resume(s.subscriptionId, 'k4');
    const updates = fake.calls.filter((x) => x.method === 'POST' && x.path === `/v1/subscriptions/${s.subscriptionId}`);
    expect(updates[0]!.form['pause_collection']).toEqual({ behavior: 'void' });
    expect(updates[1]!.form['pause_collection']).toBe('');
  });

  it('a paid-invoice webhook carries the amount as Money and subscription events map the subscription', async () => {
    const { fake, port } = harness();
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'k1');
    const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 'k2');
    const paid = await port.parseWebhook(...tuple(fake.payInvoice(s.subscriptionId)));
    expect(paid).toMatchObject({ type: 'invoice.paid', subscriptionId: s.subscriptionId, amount: price });
    const updated = await port.parseWebhook(...tuple(fake.subscriptionUpdated(s.subscriptionId)));
    expect(updated.type).toBe('subscription.updated');
    if (updated.type === 'subscription.updated') expect(updated.subscription.subscriptionId).toBe(s.subscriptionId);
  });

  it('stale webhooks (older than 5 minutes) and unhandled event types are refused', async () => {
    const { fake, port } = harness();
    const c = await port.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'k1');
    const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 'k2');
    const hook = fake.payInvoice(s.subscriptionId);
    await expect(port.parseWebhook(fake.sign(hook.rawBody, 301), hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    const odd = JSON.stringify({ id: 'evt_odd', type: 'charge.refunded', data: { object: { id: 'ch_1' } } });
    await expect(port.parseWebhook(fake.sign(odd), odd)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('a wrong API key and a transport failure surface as PROVIDER_UNAVAILABLE / typed errors, never as success', async () => {
    const fake = new FakeStripe({ secretKey, webhookSecret });
    const wrongKey = new StripeBillingAdapter({ secretKey: 'sk_test_other', webhookSecret, planProducts: { club: 'prod_club' }, fetch: fake.fetch });
    await expect(wrongKey.createCustomer({ partyId: 'p', email: 'f@example.com' }, 'k')).rejects.toMatchObject({ name: 'BillingError', code: 'INVALID_STATE' });
    const down = new StripeBillingAdapter({ secretKey, webhookSecret, planProducts: { club: 'prod_club' }, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.get('sub_x')).rejects.toMatchObject({ name: 'BillingError', code: 'PROVIDER_UNAVAILABLE' });
    fake.outageRequests = 1;
    const flaky = new StripeBillingAdapter({ secretKey, webhookSecret, planProducts: { club: 'prod_club' }, fetch: fake.fetch });
    await expect(flaky.get('sub_x')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fake.calls).toHaveLength(0); // the outage reply was served before routing: no retry happened
  });
});

const tuple = (h: { headers: Record<string, string>; rawBody: string }): [Record<string, string>, string] => [h.headers, h.rawBody];

// StripeFundingAdapter passes fundingContract against the fake Stripe (T-0301, REQ-WAL-002/003).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { fundingContract } from '@kesher/ports/contracts';
import { FakeStripe } from './fake-stripe.ts';
import { StripeFundingAdapter } from './funding.ts';

const secretKey = 'sk_test_fake_key';
const webhookSecret = 'whsec_fake_signing_secret';

function harness(clock: AdvanceableClock = fixedClock() as AdvanceableClock) {
  const fake = new FakeStripe({ secretKey, webhookSecret, clock });
  const port = new StripeFundingAdapter({ secretKey, webhookSecret, fetch: fake.fetch, clock });
  return { fake, port };
}

const fakes = new WeakMap<object, FakeStripe>();
const make = () => {
  const h = harness();
  fakes.set(h.port, h.fake);
  return h.port;
};

fundingContract('stripe', make, {
  goodPaymentMethod: 'pm_card_ok',
  declinedPaymentMethod: 'pm_card_declined',
  outagePaymentMethod: 'pm_outage',
  achPaymentMethod: 'pm_us_bank_ok',
  succeededWebhook: async (port, loadId) => fakes.get(port)!.settlePaymentIntent(loadId),
  norefundPaymentMethod: 'pm_card_norefund',
});

describe('StripeFundingAdapter specifics', () => {
  const amount = money(10_000n, 'USD');
  /** Stripe serialises amounts as JSON integers; tests build them from bigint so no number literal is money. */
  const stripeInt = (minor: bigint): number => Number(minor);

  it('RTP is refused with UNSUPPORTED_METHOD before any vendor call', async () => {
    const { fake, port } = harness();
    await expect(port.createLoad({ customerId: 'c', method: 'rtp', amount, paymentMethodId: 'pm_card_ok' }, 'k')).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
    expect(fake.calls).toHaveLength(0);
  });

  it('ACH goes through us_bank_account and is spendable after 3 business days (Mon -> Thu)', async () => {
    const monday = fixedClock('2026-11-02T10:00:00Z') as AdvanceableClock;
    const { fake, port } = harness(monday);
    const l = await port.createLoad({ customerId: 'c', method: 'ach', amount, paymentMethodId: 'pm_us_bank_ok' }, 'k');
    expect(l.status).toBe('on_hold');
    expect(l.holdUntil!.slice(0, 10)).toBe('2026-11-05');
    const call = fake.calls.find((x) => x.path === '/v1/payment_intents')!;
    expect(call.form['payment_method_types']).toEqual(['us_bank_account']);
    expect(call.form['amount']).toBe('10000');
    expect(call.form['currency']).toBe('usd');
    expect(call.idempotencyKey).toBe('k');
    expect((await port.getLoad(l.loadId)).holdUntil).toBe(l.holdUntil);
  });

  it('wallet loads are card PaymentIntents tagged with the wallet method', async () => {
    const { fake, port } = harness();
    const l = await port.createLoad({ customerId: 'c', method: 'apple_pay', amount, paymentMethodId: 'pm_card_ok' }, 'k');
    expect(l.method).toBe('apple_pay');
    expect(l.status).toBe('succeeded');
    const call = fake.calls.find((x) => x.path === '/v1/payment_intents')!;
    expect(call.form['payment_method_types']).toEqual(['card']);
    expect((call.form['metadata'] as Record<string, string>)['method']).toBe('apple_pay');
    expect((await port.getLoad(l.loadId)).method).toBe('apple_pay');
  });

  it('a 3DS challenge comes back as requires_action with the client secret', async () => {
    const { port } = harness();
    const l = await port.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_3ds' }, 'k');
    expect(l.status).toBe('requires_action');
    expect(l.clientSecret).toMatch(/_secret_/);
  });

  it('a failed PaymentIntent webhook maps to failed with the decline code', async () => {
    const { fake, port } = harness();
    const l = await port.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_3ds' }, 'k');
    const hook = fake.settlePaymentIntent(l.loadId, 'failed');
    const e = await port.parseWebhook(hook.headers, hook.rawBody);
    expect(e.load.status).toBe('failed');
    expect(e.load.failureCode).toBe('generic_decline');
  });

  it('refuses a webhook whose amount differs from the load it created', async () => {
    const { fake, port } = harness();
    const l = await port.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_ok' }, 'k');
    const tampered = JSON.stringify({ id: 'evt_t', type: 'payment_intent.succeeded', data: { object: { id: l.loadId, amount: stripeInt(999n), currency: 'usd', status: 'succeeded', metadata: { method: 'card' } } } });
    await expect(port.parseWebhook(fake.sign(tampered), tampered)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refunds post to /v1/refunds against the PaymentIntent with the key; a pending refund is read back by id', async () => {
    const { fake, port } = harness();
    const l = await port.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_slowrefund' }, 'k');
    const r = await port.refund({ loadId: l.loadId, amount: money(2_500n, 'USD') }, 'rk');
    expect(r).toMatchObject({ loadId: l.loadId, amount: money(2_500n, 'USD'), status: 'pending' });
    const call = fake.calls.find((x) => x.path === '/v1/refunds')!;
    expect(call.form['payment_intent']).toBe(l.loadId);
    expect(call.form['amount']).toBe('2500');
    expect(call.idempotencyKey).toBe('rk');
    fake.settleRefund(r.refundId);
    expect((await port.getRefund(r.refundId)).status).toBe('succeeded');
    await expect(port.getRefund('re_nope')).rejects.toMatchObject({ code: 'UNKNOWN_REFUND' });
  });

  it('unknown payment methods and unknown statuses fail secure', async () => {
    const { fake, port } = harness();
    await expect(port.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_mystery' }, 'k')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const odd = JSON.stringify({ id: 'evt_o', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x', amount: stripeInt(100n), currency: 'usd', status: 'teleported', metadata: { method: 'card' } } } });
    await expect(port.parseWebhook(fake.sign(odd), odd)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

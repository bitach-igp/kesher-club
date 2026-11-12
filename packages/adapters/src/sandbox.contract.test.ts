// Sandbox runs for the Stripe and notification adapters (T-0041). Off unless SANDBOX_CONTRACTS=1 and the vendor's own sandbox
// credentials are set, so CI (which sets neither) skips every block; run it by hand, or from a job that sets both (none does yet). Nothing here uses a live key:
// Stripe takes a test-mode key only, Twilio's test credentials or a trial account, Postmark's POSTMARK_API_TEST server token or a
// sandbox server, and Expo takes any well-formed token. The notification suites are the full NotifyPort contract, the same one each
// adapter passes against its fake. Stripe is a smoke subset, not its contract suites: those need a signed vendor webhook on demand
// and payment methods attached to a customer, which the sandbox does not hand out unattended.
import { randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@kesher/ports';
import { notifyContract } from '@kesher/ports/contracts';
import { ExpoPushNotifyAdapter } from './expo-push/expo-push.ts';
import { PostmarkNotifyAdapter } from './postmark/postmark.ts';
import { StripeBillingAdapter } from './stripe/billing.ts';
import { StripeFundingAdapter } from './stripe/funding.ts';
import { signStripePayload } from './stripe/signature.ts';
import { CrowdedClient, SANDBOX_BASE_URL } from './crowded/client.ts';
import { CrowdedMemberAccounts } from './crowded/member-accounts.ts';
import { TwilioNotifyAdapter } from './twilio/twilio.ts';

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};
const enabled = env('SANDBOX_CONTRACTS') === '1';
const BAD = 'not-a-recipient';

const twilio = { sid: env('SANDBOX_TWILIO_ACCOUNT_SID'), token: env('SANDBOX_TWILIO_AUTH_TOKEN'), from: env('SANDBOX_TWILIO_FROM'), to: env('SANDBOX_TWILIO_TO') };
if (enabled && twilio.sid && twilio.token && twilio.from && twilio.to) {
  notifyContract(
    'twilio sandbox',
    () => new TwilioNotifyAdapter({ accountSid: twilio.sid!, authToken: twilio.token!, from: { sms: twilio.from! }, templates: { 'money.received': { en: '{{from}} sent you {{amount}}', he: '{{from}} sent you {{amount}}' } } }),
    { channel: 'sms', goodRecipient: twilio.to, badRecipient: BAD },
  );
} else {
  describe.skip('NotifyPort contract: twilio sandbox (SANDBOX_CONTRACTS=1 with SANDBOX_TWILIO_ACCOUNT_SID, _AUTH_TOKEN, _FROM and _TO)', () => it('skipped', () => undefined));
}

const postmark = { token: env('SANDBOX_POSTMARK_SERVER_TOKEN'), from: env('SANDBOX_POSTMARK_FROM'), alias: env('SANDBOX_POSTMARK_ALIAS'), to: env('SANDBOX_POSTMARK_TO') };
if (enabled && postmark.token && postmark.from && postmark.alias && postmark.to) {
  notifyContract(
    'postmark sandbox',
    () => new PostmarkNotifyAdapter({ serverToken: postmark.token!, from: postmark.from!, templates: { 'money.received': { en: postmark.alias!, he: postmark.alias! } } }),
    { channel: 'email', goodRecipient: postmark.to, badRecipient: BAD },
  );
} else {
  describe.skip('NotifyPort contract: postmark sandbox (SANDBOX_CONTRACTS=1 with SANDBOX_POSTMARK_SERVER_TOKEN, _FROM, _ALIAS and _TO)', () => it('skipped', () => undefined));
}

const expo = { token: env('SANDBOX_EXPO_PUSH_TOKEN'), access: env('SANDBOX_EXPO_ACCESS_TOKEN') };
if (enabled && expo.token) {
  notifyContract(
    'expo sandbox',
    () =>
      new ExpoPushNotifyAdapter({
        ...(expo.access ? { accessToken: expo.access } : {}),
        templates: { 'money.received': { title: { en: 'Money received', he: 'Money received' }, body: { en: '{{from}} sent you {{amount}}', he: '{{from}} sent you {{amount}}' } } },
      }),
    { channel: 'push', goodRecipient: expo.token, badRecipient: BAD },
  );
} else {
  describe.skip('NotifyPort contract: expo sandbox (SANDBOX_CONTRACTS=1 with SANDBOX_EXPO_PUSH_TOKEN)', () => it('skipped', () => undefined));
}

const stripe = { key: env('STRIPE_SANDBOX_SECRET_KEY'), secret: env('STRIPE_SANDBOX_BILLING_WEBHOOK_SECRET') };
describe.skipIf(!(enabled && stripe.key && stripe.secret && /^(sk|rk)_test_/.test(stripe.key)))('Stripe sandbox smoke', () => {
  const clock = fixedClock();
  const make = () => ({
    billing: new StripeBillingAdapter({ secretKey: stripe.key!, webhookSecret: stripe.secret!, planProducts: {} }),
    funding: new StripeFundingAdapter({ secretKey: stripe.key!, webhookSecret: stripe.secret!, clock }),
  });

  it('creates a customer once per key and a SetupIntent for it, with the Payment Element wallet flags echoed', async () => {
    const { billing } = make();
    const key = `smoke-${Date.now()}`;
    const a = await billing.createCustomer({ partyId: 'smoke-party', email: 'smoke@example.com' }, key);
    const b = await billing.createCustomer({ partyId: 'smoke-party', email: 'smoke@example.com' }, key);
    expect(b.customerId).toBe(a.customerId);
    const sheet = await billing.createSetupSheet(a.customerId, { applePay: false, googlePay: false });
    expect(sheet.clientSecret).toMatch(/_secret_/);
    expect(sheet.wallets).toEqual({ applePay: false, googlePay: false });
  });

  it('answers a PaymentIntent it does not know with UNKNOWN_LOAD', async () => {
    await expect(make().funding.getLoad('pi_does_not_exist')).rejects.toMatchObject({ code: 'UNKNOWN_LOAD' });
  });

  it('refuses a webhook signed with another secret', async () => {
    const { funding } = make();
    const raw = JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } });
    const forged = { 'stripe-signature': signStripePayload('whsec_not_the_secret', raw, Math.floor(clock.now().getTime() / 1000)) };
    await expect(funding.parseWebhook(forged, raw)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
  });
});

// Crowded member accounts (T-0699): one contact with a unique mobile and one wallet account in the sandbox platform chapter, and a
// second call that is a no-op. Needs the sandbox token and the platform chapter's id (CROWDED_SANDBOX_CHAPTER_ID); CROWDED_BASE_URL
// overrides the sandbox URL. It cannot test KYC outcomes or a payment (the sandbox has no collect payment simulator). The mobile and
// email are made up and unique per run; the contact stays in the sandbox (archiving is out of scope).
const crowded = { token: env('CROWDED_SANDBOX_TOKEN'), chapterId: env('CROWDED_SANDBOX_CHAPTER_ID'), baseUrl: env('CROWDED_BASE_URL') ?? SANDBOX_BASE_URL };
describe.skipIf(!(enabled && crowded.token && crowded.chapterId))('Crowded member accounts sandbox', () => {
  it('creates one contact and one wallet account, and the second call creates nothing', async () => {
    const posts: string[] = [];
    const spyFetch: typeof globalThis.fetch = (input, init) => {
      if ((init?.method ?? 'GET') === 'POST') posts.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url).pathname.replace(/^.*\/api\/v1/, ''));
      return globalThis.fetch(input, init);
    };
    const hmacKey = randomBytes(32).toString('hex');
    const build = () => new CrowdedMemberAccounts({ client: new CrowdedClient({ baseUrl: crowded.baseUrl, token: crowded.token!, fetch: spyFetch }), chapterId: crowded.chapterId!, hmacKey });
    const unique = `${Date.now()}${randomInt(1000, 9999)}`;
    const member = { partyId: `sandbox-${unique}`, firstName: 'Sandbox', lastName: 'Member', email: `sandbox-${unique}@example.test`, mobile: `+1415555${String(randomInt(0, 10000)).padStart(4, '0')}` };
    const adapter = build();
    const first = await adapter.ensureAccount(member, `sandbox-key-${unique}`);
    expect(first.status).toBe('open');
    expect(posts.filter((p) => p.endsWith('/contacts'))).toHaveLength(1);
    expect(posts.filter((p) => p.endsWith('/accounts'))).toHaveLength(1);
    const before = posts.length;
    expect(await adapter.ensureAccount(member, `sandbox-key-${unique}-b`)).toEqual(first);
    expect(posts.length).toBe(before); // the same adapter: nothing is sent but reads
    // a fresh adapter with an empty ledger finds the contact by its mobile: no contact create, the same refs
    expect(await build().ensureAccount(member, `sandbox-key-${unique}-c`)).toEqual(first);
    expect(posts.filter((p) => p.endsWith('/contacts'))).toHaveLength(1);
    const r = first as { accountRef: string };
    const view = await adapter.account(r.accountRef);
    expect(typeof view.balance.minor).toBe('bigint');
  });
});

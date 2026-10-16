// CoverGeniusInsuranceAdapter passes insuranceContract against the fake XCover (TST-INSR-001 /
// REQ-INSR-001, T-0720). Nightly it runs against the XCover sandbox with XCOVER_SANDBOX_* credentials.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { insuranceContract } from '@kesher/ports/contracts';
import { FAKE_XCOVER_OUTAGE_POLICY_TYPE, FakeXCover } from './fake-xcover.ts';
import { CoverGeniusInsuranceAdapter, type CoverGeniusInsuranceOptions } from './insurance.ts';

const creds = { partnerCode: 'KESHER', apiKey: 'fake-xcover-key', apiSecret: 'fake-xcover-secret' };
const disclosures = {
  licensedEntity: 'XCover (Cover Genius Ltd), licensed insurance intermediary',
  commissionDisclosure: 'Kesher Club receives a commission from the insurer, included in the premium shown.',
};
const products: CoverGeniusInsuranceOptions['products'] = {
  'travel-il': { policyType: 'travel_il_v1', policyTypeVersion: 1, commissionBps: 1500n },
  gadget: { policyType: 'gadget_protection', commissionBps: 2000n },
  outage: { policyType: FAKE_XCOVER_OUTAGE_POLICY_TYPE, commissionBps: 0n },
};

function harness(clock: AdvanceableClock = fixedClock() as AdvanceableClock) {
  const fake = new FakeXCover({ ...creds, clock });
  const port = new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures, fetch: fake.fetch, clock });
  return { fake, port };
}

insuranceContract('cover-genius', () => harness().port, { product: 'travel-il', outageProduct: 'outage' });

describe('CoverGeniusInsuranceAdapter specifics', () => {
  const input = { product: 'travel-il', memberId: 'm1', market: 'IL' as const, startsAt: '2026-11-01T00:00:00Z', days: 30 };

  it('disclosures: fixed wording from config, policy wording URL from the quote pds_url (REQ-INSR-001)', async () => {
    const { fake, port } = harness();
    const q = await port.quote(input);
    expect(q.disclosures).toEqual({ ...disclosures, policyWordingUrl: 'https://www.xcover.com/en/pds/fake-travel-il' });
    expect(q.premium).toEqual(money(1200n, 'USD'));
    expect(q.commission).toEqual(money(180n, 'USD'));
    expect(q.coverageSummary).toEqual(['Medical expenses in Israel up to $100,000', 'Trip delay and baggage']);
    const call = fake.calls.find((c) => c.path.endsWith('/quotes/'))!;
    expect(call.signed).toBe(true);
    expect(call.body).toMatchObject({ currency: 'USD', customer_country: 'IL', request: [{ policy_type: 'travel_il_v1', policy_type_version: 1, policy_start_date: '2026-11-01T00:00:00.000Z', policy_end_date: '2026-12-01T00:00:00.000Z' }] });
  });

  it('refuses to construct without the fixed disclosures, and refuses a quote without pds_url', async () => {
    expect(() => new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures: { licensedEntity: ' ', commissionDisclosure: disclosures.commissionDisclosure } })).toThrow(/licensedEntity/);
    expect(() => new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures: { licensedEntity: 'X', commissionDisclosure: 'We get paid.' } })).toThrow(/commission/);
    const stripped: typeof fetch = async () => new Response(JSON.stringify({ id: 'Q-1', status: 'QUOTED', currency: 'USD', quotes: { a: { id: 'a', status: 'QUOTED', price: '12.00', policy_start_date: input.startsAt, policy_end_date: input.startsAt } } }), { status: 200 });
    const port = new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures, fetch: stripped });
    await expect(port.quote(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('binds through POST /bookings/{id}/ and cancels through /cancel/; policy dates follow the quote', async () => {
    const { fake, port } = harness();
    const q = await port.quote(input);
    const p = await port.bind(q.quoteId, 'b-1');
    expect(p).toMatchObject({ policyId: q.quoteId, quoteId: q.quoteId, status: 'active', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' });
    expect(p.certificateUrl).toMatch(/^https:\/\/www\.xcover\.com\//);
    expect(await port.getPolicy(p.policyId)).toEqual(p);
    const c = await port.cancel(p.policyId, 'c-1');
    expect(c.status).toBe('cancelled');
    expect((await port.getPolicy(p.policyId)).status).toBe('cancelled');
    expect(fake.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /x/partners/KESHER/quotes/',
      `POST /x/partners/KESHER/bookings/${q.quoteId}/`,
      `GET /x/partners/KESHER/bookings/${q.quoteId}/`,
      `POST /x/partners/KESHER/bookings/${q.quoteId}/cancel/`,
      `GET /x/partners/KESHER/bookings/${q.quoteId}/`,
    ]);
  });

  it('an expired quote cannot be bound: locally by our clock, and from the vendor reply', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const { fake, port } = harness(clock);
    const q1 = await port.quote(input);
    clock.advance(31 * 60_000);
    await expect(port.bind(q1.quoteId, 'b-1')).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    const q2 = await port.quote(input);
    fake.expireQuote(q2.quoteId);
    await expect(port.bind(q2.quoteId, 'b-2')).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('unknown products never reach XCover; vendor-rejected policy types, bad keys and outages map to typed errors', async () => {
    const { fake, port } = harness();
    await expect(port.quote({ ...input, product: 'nope' })).rejects.toMatchObject({ code: 'UNKNOWN_PRODUCT' });
    expect(fake.calls).toHaveLength(0);
    const misconfigured = new CoverGeniusInsuranceAdapter({ ...creds, products: { x: { policyType: 'retired_type', commissionBps: 0n } }, disclosures, fetch: fake.fetch });
    await expect(misconfigured.quote({ ...input, product: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_PRODUCT' });
    const badKey = new CoverGeniusInsuranceAdapter({ ...creds, apiSecret: 'wrong', products, disclosures, fetch: fake.fetch });
    await expect(badKey.quote(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    fake.outageRequests = 1;
    await expect(port.getPolicy('0001-FAKE-INS')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const down = new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.getPolicy('x')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('uses the vendor-stated partner commission when present and refuses one outside the premium', async () => {
    const reply = (commission: number) => (async () => new Response(JSON.stringify({ id: 'Q-2', status: 'QUOTED', currency: 'USD', quotes: { a: { id: 'a', status: 'QUOTED', price: '10.00', partner_commission: commission, pds_url: 'https://www.xcover.com/en/pds/x', policy_start_date: input.startsAt, policy_end_date: input.startsAt } } }), { status: 200 })) as typeof fetch;
    const good = new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures, fetch: reply(2.5) });
    expect((await good.quote(input)).commission).toEqual(money(250n, 'USD'));
    const bad = new CoverGeniusInsuranceAdapter({ ...creds, products, disclosures, fetch: reply(11) });
    await expect(bad.quote(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

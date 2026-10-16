// AiraloEsimAdapter passes esimContract against the fake Airalo (TST-ESIM-001 / REQ-ESIM-001, T-0710).
// The same file runs nightly against the Airalo sandbox with AIRALO_SANDBOX_CLIENT_ID/_SECRET.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { esimContract } from '@kesher/ports/contracts';
import { AiraloEsimAdapter } from './esim.ts';
import { FAKE_AIRALO_FAILING_SKU, FakeAiralo } from './fake-airalo.ts';
import { decimalToMinor } from './money.ts';

const clientId = 'fake-airalo-client-id';
const clientSecret = 'fake-airalo-client-secret';

function harness(clock: AdvanceableClock = fixedClock() as AdvanceableClock) {
  const fake = new FakeAiralo({ clientId, clientSecret, clock });
  const port = new AiraloEsimAdapter({ clientId, clientSecret, fetch: fake.fetch, clock });
  return { fake, port };
}

esimContract('airalo', () => harness().port, { failingSku: FAKE_AIRALO_FAILING_SKU });

describe('AiraloEsimAdapter specifics', () => {
  it('maps Airalo packages: price -> USD minor units, amount MB -> GB, unlimited skipped (REQ-ESIM-001)', async () => {
    const { port } = harness();
    const pkgs = await port.listPackages('IL');
    expect(pkgs.map((p) => p.sku)).not.toContain('israel-30days-unlimited');
    expect(pkgs.find((p) => p.sku === 'israel-7days-1gb')).toEqual({ sku: 'israel-7days-1gb', country: 'IL', dataGb: 1, days: 7, cost: money(450n, 'USD') });
    expect(pkgs.find((p) => p.sku === 'israel-30days-10gb')!.cost).toEqual(money(2650n, 'USD'));
    expect(await port.listPackages('US')).toHaveLength(1);
  });

  it('builds the iOS 17.4 universal link from the LPA string and keeps the vendor order id', async () => {
    const { fake, port } = harness();
    const o = await port.order('israel-7days-1gb', 'k-1');
    expect(o.lpa).toBe(`LPA:1$fake.smdp.airalo.example$FAKE-${Number(o.orderId) - 100_000}`);
    expect(o.installUrl).toBe(`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(o.lpa)}`);
    expect(o.iccid).toMatch(/^8997/);
    const call = fake.calls.find((c) => c.path === '/v2/orders')!;
    expect(call.form).toMatchObject({ package_id: 'israel-7days-1gb', quantity: '1', type: 'sim', description: 'k-1' });
  });

  it('fetches a client-credentials token once and reuses it until it expires', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const { fake, port } = harness(clock);
    await port.listPackages('IL');
    await port.listPackages('IL');
    expect(fake.tokenRequests).toBe(1);
    clock.advance(3600 * 1000);
    await port.listPackages('IL');
    expect(fake.tokenRequests).toBe(2);
    const bad = new AiraloEsimAdapter({ clientId, clientSecret: 'wrong', fetch: fake.fetch, clock });
    await expect(bad.listPackages('IL')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('usage comes back in MB with an ISO expiry; top-ups add the package and are idempotent', async () => {
    const { fake, port } = harness(fixedClock('2026-11-01T09:00:00Z') as AdvanceableClock);
    const o = await port.order('israel-7days-1gb', 'k-1');
    fake.setRemaining(o.iccid, 300);
    const u = await port.getUsage(o.iccid);
    expect(u).toEqual({ iccid: o.iccid, usedMb: 724, totalMb: 1024, expiresAt: '2026-11-08T09:00:00.000Z' });
    const t1 = await port.topUp(o.iccid, 'israel-15days-3gb', 't-1');
    const t2 = await port.topUp(o.iccid, 'israel-15days-3gb', 't-1');
    expect(t1.totalMb).toBe(1024 + 3072);
    expect(t2).toEqual(t1);
    expect(fake.calls.filter((c) => c.path === '/v2/orders/topups')).toHaveLength(1);
    await expect(port.topUp(o.iccid, 'NOPE', 't-2')).rejects.toMatchObject({ code: 'UNKNOWN_SKU' });
    await expect(port.topUp('000', 'israel-15days-3gb', 't-3')).rejects.toMatchObject({ code: 'UNKNOWN_ICCID' });
  });

  it('maps vendor errors to typed codes and never retries', async () => {
    const { fake, port } = harness();
    await expect(port.order('NOPE', 'k')).rejects.toMatchObject({ code: 'UNKNOWN_SKU' });
    await expect(port.getUsage('000')).rejects.toMatchObject({ code: 'UNKNOWN_ICCID' });
    fake.outageRequests = 1;
    const before = fake.calls.length;
    await expect(port.listPackages('IL')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fake.calls.length).toBe(before + 1);
    const down = new AiraloEsimAdapter({ clientId, clientSecret, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.listPackages('IL')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('decimalToMinor never floats and refuses sub-cent precision', () => {
    expect(decimalToMinor(4.5, 'USD')).toEqual(money(450n, 'USD'));
    expect(decimalToMinor('26.50', 'USD')).toEqual(money(2650n, 'USD'));
    expect(decimalToMinor(11, 'USD')).toEqual(money(1100n, 'USD'));
    expect(decimalToMinor('0.07', 'USD')).toEqual(money(7n, 'USD'));
    expect(() => decimalToMinor(1.005, 'USD')).toThrow(RangeError);
    expect(() => decimalToMinor(-1, 'USD')).toThrow(RangeError);
    expect(() => decimalToMinor('abc', 'USD')).toThrow(RangeError);
    expect(() => decimalToMinor(undefined, 'USD')).toThrow(RangeError);
  });
});

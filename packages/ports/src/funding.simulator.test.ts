import { describe, expect, it } from 'vitest';
import { money, type Money } from '@kesher/domain';
import { type AdvanceableClock, fixedClock } from './base.ts';
import { FundingError, isFundingCreditPort, isHttpsUrl, isPublicIp } from './funding.ts';
import { fundingContract, fundingStatementContract } from './funding.contract.ts';
import { addBusinessDays, FundingSimulator } from './funding.simulator.ts';

fundingContract('simulator', () => new FundingSimulator(), {
  goodPaymentMethod: 'pm_card_ok',
  declinedPaymentMethod: 'pm_declined',
  outagePaymentMethod: 'pm_outage',
  achPaymentMethod: 'pm_bank_ok',
  succeededWebhook: async (port, id) => (port as FundingSimulator).webhookFor(id, 'succeeded'),
  norefundPaymentMethod: 'pm_norefund',
  hosted: true,
});

fundingStatementContract('simulator', () => new FundingSimulator(fixedClock()), {
  goodPaymentMethod: 'pm_card_ok',
  achPaymentMethod: 'pm_bank_ok',
  slowRefundPaymentMethod: 'pm_slowrefund',
  clockOf: (port) => (port as FundingSimulator).clock as AdvanceableClock,
  failListingFrom: (port, after) => {
    (port as FundingSimulator).outageAfterPages = after;
  },
});

const creditLoad = async (sim: FundingSimulator, state: 'succeeded' | 'processing' | 'requires_action' | 'failed' | 'on_hold', amount: Money): Promise<string> => {
  if (state === 'succeeded') return (await sim.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_ok' }, `K-${Math.random()}-ok`)).loadId;
  if (state === 'on_hold') return (await sim.createLoad({ customerId: 'c', method: 'ach', amount, paymentMethodId: 'pm_bank_ok' }, `K-${Math.random()}-ach`)).loadId;
  const l = await sim.createLoad({ customerId: 'c', method: 'hosted', amount, hosted: { payerIp: '203.0.113.7', userConsented: true } }, `K-${Math.random()}-h`);
  if (state === 'processing') sim.payHosted(l.loadId, 'ach');
  if (state === 'failed') sim.failHosted(l.loadId, 'DECLINED');
  return l.loadId;
};

fundingContract('simulator with credit', () => new FundingSimulator(fixedClock(), { credit: true }), {
  goodPaymentMethod: 'pm_card_ok',
  succeededWebhook: async (port, id) => (port as FundingSimulator).webhookFor(id, 'succeeded'),
  hosted: true,
  credit: {
    accountRef: 'acct_member_1',
    unknownAccountRef: 'acct_unknown',
    loadIn: (port, state, amount) => creditLoad(port as FundingSimulator, state, amount),
    creditCount: (port, loadId) => (port as FundingSimulator).creditCount(loadId),
    failNext: (port, code) => (port as FundingSimulator).failNext(code),
    pendNext: (port) => (port as FundingSimulator).pendNext(),
    outageNext: (port) => (port as FundingSimulator).outageNext(),
  },
});

describe('FundingSimulator credit capability (T-0704)', () => {
  it('only a simulator built with { credit: true } has creditWallet', () => {
    expect(isFundingCreditPort(new FundingSimulator())).toBe(false);
    expect(isFundingCreditPort(new FundingSimulator(fixedClock()))).toBe(false);
    expect(isFundingCreditPort(new FundingSimulator(fixedClock(), { credit: true }))).toBe(true);
    expect(isFundingCreditPort(null)).toBe(false);
  });
});

describe('FundingSimulator hosted load controls (T-0697, TST-WAL-002)', () => {
  const amount = money(10_000n, 'USD');
  const hosted = { payerIp: '203.0.113.7', userConsented: true } as const;
  const start = async (sim: FundingSimulator, key = 'H-key-1') => sim.createLoad({ customerId: 'c', method: 'hosted', amount, hosted }, key);

  it('payHosted(card) makes the load succeeded with method card and no action', async () => {
    const sim = new FundingSimulator();
    const l = await start(sim);
    const paid = sim.payHosted(l.loadId, 'card');
    expect(paid).toMatchObject({ loadId: l.loadId, status: 'succeeded', method: 'card', amount });
    expect(paid.action).toBeUndefined();
    expect(await sim.getLoad(l.loadId)).toEqual(paid);
    const settled = await sim.listSettled({ from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' });
    expect(settled.entries.map((e) => e.id)).toEqual([l.loadId]);
  });

  it('payHosted(ach) makes it processing, then settle puts it on hold three business days on', async () => {
    const sim = new FundingSimulator(fixedClock('2026-11-02T10:00:00Z')); // a Monday
    const l = await start(sim);
    expect(sim.payHosted(l.loadId, 'ach')).toMatchObject({ status: 'processing', method: 'ach' });
    const held = sim.settle(l.loadId);
    expect(held).toMatchObject({ status: 'on_hold', method: 'ach' });
    expect(held.holdUntil!.slice(0, 10)).toBe('2026-11-05');
  });

  it('failHosted makes it failed with that code', async () => {
    const sim = new FundingSimulator();
    const l = await start(sim);
    expect(sim.failHosted(l.loadId, 'DECLINED')).toMatchObject({ status: 'failed', failureCode: 'DECLINED' });
    expect((await sim.getLoad(l.loadId)).action).toBeUndefined();
  });

  it('only a pending hosted load can be paid or failed', async () => {
    const sim = new FundingSimulator();
    const l = await start(sim);
    sim.payHosted(l.loadId, 'card');
    expect(() => sim.payHosted(l.loadId, 'ach')).toThrow(FundingError);
    expect(() => sim.failHosted(l.loadId, 'DECLINED')).toThrow(FundingError);
    const card = await sim.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_ok' }, 'H-card-1');
    expect(() => sim.payHosted(card.loadId, 'card')).toThrow(FundingError);
  });

  it('a load that is not hosted still has no action (existing callers unchanged)', async () => {
    const l = await new FundingSimulator().createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_ok' }, 'H-card-2');
    expect(l.action).toBeUndefined();
  });
});

describe('hosted loads and webhooks (T-0697)', () => {
  const amount = money(10_000n, 'USD');
  const hosted = { payerIp: '203.0.113.7', userConsented: true } as const;

  it('a succeeded webhook on a hosted load carries the method used and no action', async () => {
    const sim = new FundingSimulator();
    const l = await sim.createLoad({ customerId: 'c', method: 'hosted', amount, hosted }, 'W-key-1');
    const hook = sim.webhookFor(l.loadId, 'succeeded', 'ach');
    const ev = await sim.parseWebhook(hook.headers, hook.rawBody);
    expect(ev.load.method).toBe('ach');
    expect(ev.load.action).toBeUndefined();
    expect(await sim.getLoad(l.loadId)).toEqual(ev.load);
  });

  it('a failed webhook drops the action; the page can expire', async () => {
    const sim = new FundingSimulator();
    const l = await sim.createLoad({ customerId: 'c', method: 'hosted', amount, hosted }, 'W-key-2');
    expect(l.action?.expiresAt).toBeTruthy();
    const hook = sim.webhookFor(l.loadId, 'failed');
    expect((await sim.parseWebhook(hook.headers, hook.rawBody)).load.action).toBeUndefined();
  });
});

describe('isPublicIp and isHttpsUrl', () => {
  it('classify addresses and urls', () => {
    for (const ip of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of ['', 'x', '172.16.0.1', '172.31.255.255', '100.127.0.1', '::ffff:192.168.0.1', '::ffff:c0a8:1', 'fc00::1', 'fe80::1%eth0', '1::2::3', '12345::1', '01.2.3.4']) expect(isPublicIp(ip), ip).toBe(false);
    expect(isHttpsUrl('https://a.example/p?q=1')).toBe(true);
    for (const u of ['HTTP://a.example', 'https://u@a.example', 'https:///x', '//a.example']) expect(isHttpsUrl(u), u).toBe(false);
  });
});

describe('isPublicIp ranges that are not public (T-0735, TST-INS-006)', () => {
  const rows: [string, string][] = [
    ['2002::1', '6to4 (2002::/16) embeds an IPv4 we do not decode'],
    ['2002:c0a8:0101::1', '6to4 around a private IPv4'],
    ['2002:0808:0808::1', '6to4 around a public IPv4 is still refused'],
    ['2001:db8::1', 'documentation (2001:db8::/32)'],
    ['2001:db8:ffff::2', 'documentation, high end'],
    ['fc00::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['10.0.0.1', 'private v4'],
  ];
  it.each(rows)('%s is not public (%s)', (ip) => expect(isPublicIp(ip)).toBe(false));
  it('a public IPv6 and its neighbours of 2001:db8 stay accepted', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2001:db9::1', '2001:db7::1', '2003::1']) expect(isPublicIp(ip), ip).toBe(true);
  });
});

describe('FundingSimulator metadata (T-0735)', () => {
  it('returns the metadata a load was created with, and undefined otherwise', async () => {
    const sim = new FundingSimulator();
    const base = { customerId: 'c', method: 'card' as const, amount: money(1_000n, 'USD'), paymentMethodId: 'pm_card_ok' };
    const withMd = await sim.createLoad({ ...base, metadata: { campaign: 'spring' } }, 'key-meta-0001');
    expect(withMd.metadata).toEqual({ campaign: 'spring' });
    expect((await sim.getLoad(withMd.loadId)).metadata).toEqual({ campaign: 'spring' });
    expect((await sim.createLoad(base, 'key-meta-0002')).metadata).toBeUndefined();
  });
});

describe('FundingSimulator specifics', () => {
  it('an ACH load on Monday with a 3-day hold is spendable Thursday (REQ-WAL-003)', async () => {
    const monday = fixedClock('2026-11-02T10:00:00Z'); // 2026-11-02 is a Monday
    const sim = new FundingSimulator(monday);
    const l = await sim.createLoad({ customerId: 'c', method: 'ach', amount: money(5000n, 'USD'), paymentMethodId: 'pm_bank_ok' }, 'k');
    expect(l.holdUntil!.slice(0, 10)).toBe('2026-11-05');
  });

  it('business-day arithmetic skips weekends', () => {
    expect(addBusinessDays(new Date('2026-11-06T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-11-09'); // Fri -> Mon
  });
});

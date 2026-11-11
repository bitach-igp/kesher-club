// T-0718 (TST-WAL-003, TST-LED-003): the mirror simulator passes the MirrorPort contract, and its fixtures do what its
// header says.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { mirrorContract } from './mirror.contract.ts';
import { isMirrorPort, MirrorError, mirrorItemResult } from './mirror.ts';
import { MirrorSimulator } from './mirror.simulator.ts';
import { InstitutionBankingSimulator } from './institution-banking.simulator.ts';
import { FundingSimulator } from './funding.simulator.ts';

const CHAPTER = 'chap_000001';
// A page of 2 so ten rows cross page boundaries. The chapter's checking account is opened once, on the first seed.
mirrorContract('simulator', () => new MirrorSimulator({ pageSize: 2 }), {
  chapterRef: CHAPTER,
  seed: async (sim, { accountRef, accountMinor, checkingMinor }) => {
    try {
      await sim.checkingBalance(CHAPTER);
    } catch {
      sim.openChapter(CHAPTER, checkingMinor);
    }
    sim.openAccount(accountRef, accountMinor);
  },
  refuse: (sim, key, code) => sim.refuse(key, code),
  vendorStatus: (sim, key, status) => sim.vendorStatus(key, status),
  loseAnswer: (sim, key) => sim.loseAnswer(key),
  loseBatch: (sim) => sim.loseBatch(),
  setStatus: (sim, ref, status) => sim.setStatus(ref, status),
  outage: (sim, on) => sim.outage(on),
});

const leg = (key: string, over: Record<string, unknown> = {}) => ({ direction: 'from_checking' as const, accountRef: 'acct_m1', amount: money(100n, 'USD'), memo: 'KC-x', idempotencyKey: key, ...over });

describe('MirrorSimulator', () => {
  it('is found as an optional capability by its methods, and other ports are not', () => {
    expect(isMirrorPort(new MirrorSimulator())).toBe(true);
    expect(isMirrorPort(new InstitutionBankingSimulator())).toBe(false);
    expect(isMirrorPort(new FundingSimulator())).toBe(false);
    expect(isMirrorPort(undefined)).toBe(false);
  });

  const open = () => {
    const sim = new MirrorSimulator();
    sim.openChapter(CHAPTER, 1_000n);
    sim.openAccount('acct_m1', 0n);
    return sim;
  };

  it('a frozen account can be reopened, an unopened one is an error, and an unknown chapter is NOT_FOUND', async () => {
    const sim = open();
    sim.setStatus('acct_m1', 'frozen');
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]).toMatchObject({ reasonCode: 'ACCOUNT_UNAVAILABLE' });
    sim.setStatus('acct_m1', 'open');
    expect((await sim.bookBatch([leg('key-leg-0002')], CHAPTER))[0]?.status).toBe('booked');
    expect(() => sim.setStatus('acct_nope', 'frozen')).toThrow();
    expect(() => sim.setHold('acct_nope', 1n)).toThrow();
    await expect(sim.bookBatch([leg('key-leg-0003')], 'chap_nope')).rejects.toBeInstanceOf(MirrorError);
    await expect(sim.checkingBalance('chap_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sim.accountBalance(CHAPTER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a hold is kept apart from the balance and cannot be drawn', async () => {
    const sim = open();
    sim.setHold('acct_m1', 0n);
    sim.openAccount('acct_m2', 500n);
    sim.setHold('acct_m2', 400n);
    expect(await sim.accountBalance('acct_m2')).toMatchObject({ balance: 500n, hold: 400n, available: 100n });
    const [r] = await sim.bookBatch([leg('key-leg-0001', { accountRef: 'acct_m2', direction: 'to_checking', amount: money(200n, 'USD'), memo: 'KC-hold' })], CHAPTER);
    expect(r).toMatchObject({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
  });

  it('a lost answer is lost once, and refuse beats loseAnswer on one key', async () => {
    const sim = open();
    sim.loseAnswer('key-leg-0001');
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]).toEqual({ status: 'unknown' });
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]?.status).toBe('booked');
    sim.loseAnswer('key-leg-0002');
    sim.refuse('key-leg-0002', 'PAYMENT_FAILED');
    expect((await sim.bookBatch([leg('key-leg-0002')], CHAPTER))[0]).toMatchObject({ status: 'refused', reasonCode: 'PAYMENT_FAILED' });
  });

  it('fixtures are one-shot, survive a refused batch, and clearFixtures drops the unused', async () => {
    const sim = open();
    sim.refuse('key-leg-0001', 'PAYMENT_FAILED');
    await expect(sim.bookBatch([leg('key-leg-0001'), leg('key-leg-0001')], CHAPTER)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]?.status).toBe('refused');
    sim.refuse('key-leg-0002', 'PAYMENT_FAILED');
    sim.clearFixtures();
    expect((await sim.bookBatch([leg('key-leg-0002')], CHAPTER))[0]?.status).toBe('booked');
  });

  it('a Pending payment moves nothing until settled, then the same key answers booked', async () => {
    const sim = open();
    sim.vendorStatus('key-leg-0001', 'Pending');
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]?.status).toBe('unknown');
    expect((await sim.accountBalance('acct_m1')).balance).toBe(0n);
    sim.settle('key-leg-0001');
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]?.status).toBe('booked');
    expect((await sim.accountBalance('acct_m1')).balance).toBe(100n);
    expect(() => sim.settle('key-leg-0001')).toThrow();
  });
});

describe('mirrorItemResult', () => {
  it('Sent is booked, Rejected is refused whatever else the item says, anything else is unknown', () => {
    expect(mirrorItemResult({ paymentStatus: 'Sent', paymentRef: 'p1' })).toEqual({ status: 'booked', paymentRef: 'p1' });
    expect(mirrorItemResult({ paymentStatus: 'Rejected' })).toEqual({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
    expect(mirrorItemResult({ paymentStatus: 'Rejected', reasonCode: 'ACCOUNT_UNAVAILABLE' })).toMatchObject({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
    for (const s of ['Pending', 'Returned', '', 'sent']) expect(mirrorItemResult({ paymentStatus: s }).status).toBe('unknown');
  });
});

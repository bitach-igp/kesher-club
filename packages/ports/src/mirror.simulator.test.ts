// T-0718 (TST-WAL-003, TST-LED-003): the mirror simulator passes the MirrorPort contract, and its fixtures do what its
// header says.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { mirrorContract } from './mirror.contract.ts';
import { isMirrorPort, MirrorError } from './mirror.ts';
import { MirrorSimulator } from './mirror.simulator.ts';
import { InstitutionBankingSimulator } from './institution-banking.simulator.ts';
import { FundingSimulator } from './funding.simulator.ts';

const CHAPTER = 'chap_000001';
// A page of 2 so ten rows cross page boundaries.
mirrorContract('simulator', () => new MirrorSimulator({ pageSize: 2 }), {
  chapterRef: CHAPTER,
  seed: async (sim, { accountRef, accountMinor, checkingMinor }) => {
    sim.openChapter(CHAPTER, checkingMinor);
    sim.openAccount(accountRef, accountMinor);
  },
  refuse: (sim, key, code) => sim.refuse(key, code),
  loseAnswer: (sim, key) => sim.loseAnswer(key),
  freeze: (sim, ref) => sim.freeze(ref),
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

  it('a frozen account can be unfrozen, and an unknown chapter is NOT_FOUND', async () => {
    const sim = new MirrorSimulator();
    sim.openChapter(CHAPTER, 1_000n);
    sim.openAccount('acct_m1', 0n);
    sim.freeze('acct_m1');
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]).toMatchObject({ reasonCode: 'ACCOUNT_UNAVAILABLE' });
    sim.freeze('acct_m1', false);
    expect((await sim.bookBatch([leg('key-leg-0002')], CHAPTER))[0]?.status).toBe('booked');
    await expect(sim.bookBatch([leg('key-leg-0003')], 'chap_nope')).rejects.toBeInstanceOf(MirrorError);
    await expect(sim.checkingBalance('chap_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sim.accountBalance('acct_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a lost answer is lost once: the replay answers the booked payment', async () => {
    const sim = new MirrorSimulator();
    sim.openChapter(CHAPTER, 1_000n);
    sim.openAccount('acct_m1', 0n);
    sim.loseAnswer('key-leg-0001');
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]).toEqual({ status: 'unknown' });
    expect((await sim.bookBatch([leg('key-leg-0001')], CHAPTER))[0]?.status).toBe('booked');
  });
});

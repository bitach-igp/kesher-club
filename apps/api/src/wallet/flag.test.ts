import { DomainError } from '@kesher/domain';
import { describe, expect, it } from 'vitest';
import { requireWalletOn, WALLET_FLAG } from './flag.ts';

const spy = (on: boolean) => {
  const calls: unknown[][] = [];
  return { calls, flags: { isOn: (...args: unknown[]) => (calls.push(args), on) } };
};

describe('requireWalletOn', () => {
  it('reads the wallet flag and passes when it is on', async () => {
    const { calls, flags } = spy(true);
    await expect(requireWalletOn(flags)).resolves.toBeUndefined();
    expect(calls).toEqual([[WALLET_FLAG]]);
    expect(WALLET_FLAG).toBe('wallet.enabled');
  });

  it('throws FEATURE_OFF with the exact message when it is off', async () => {
    const e = await requireWalletOn(spy(false).flags).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe('FEATURE_OFF');
    expect((e as DomainError).message).toBe('The wallet is not enabled yet');
  });

  it('hands a { partyId } context to the flag read', async () => {
    const { calls, flags } = spy(true);
    await requireWalletOn(flags, { partyId: 'p-1' });
    expect(calls).toEqual([[WALLET_FLAG, { partyId: 'p-1' }]]);
  });

  it('passes no second argument when no context is given', async () => {
    const { calls, flags } = spy(true);
    await requireWalletOn(flags);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it('awaits an async flag read', async () => {
    const flags = { isOn: () => Promise.resolve(false) };
    await expect(requireWalletOn(flags)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
  });
});

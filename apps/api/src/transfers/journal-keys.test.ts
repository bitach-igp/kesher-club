import { describe, expect, it } from 'vitest';
import { holdKey, releaseKey, settleKey } from './journal-keys.ts';
import { settleKey as fxSettleKey } from '../fx/service.ts';
import { settleKey as payoutSettleKey } from '../payouts/service.ts';
import { settleKey as sendSettleKey } from '../p2p/send.ts';
import { holdKey as p2pHoldKey, releaseKey as p2pReleaseKey } from '../p2p/holds.ts';
import { holdKey as loadHoldKey, releaseKey as loadReleaseKey, settleKey as loadSettleKey } from '../wallet/loads.ts';
import { refundSettleKey } from '../wallet/closure.ts';

describe('journal idempotency keys', () => {
  it('are the stored strings, exactly', () => {
    expect(settleKey('wf')).toBe('wf:settle');
    expect(holdKey('wf')).toBe('wf:hold');
    expect(releaseKey('wf')).toBe('wf:release');
  });

  it('are the ones every module has always used under its own name', () => {
    for (const f of [fxSettleKey, payoutSettleKey, sendSettleKey, loadSettleKey, refundSettleKey]) expect(f('wf-1')).toBe('wf-1:settle');
    for (const f of [p2pHoldKey, loadHoldKey]) expect(f('wf-1')).toBe('wf-1:hold');
    for (const f of [p2pReleaseKey, loadReleaseKey]) expect(f('wf-1')).toBe('wf-1:release');
  });
});

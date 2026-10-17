// M06 identity verification view model (T-0408): none → pending → approved moves on to the card;
// rejected explains the partner's reason codes and a retry opens a fresh session; review waits.
import { describe, expect, it } from 'vitest';
import type { KycApi, KycSessionStarted, KycStatus } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { createKycModel, kycMode, reasonCopy } from './kyc.model.ts';

function fakeKyc(script: KycStatus[], opts: { startFails?: 'down' | 'generic' } = {}) {
  const starts: string[] = [];
  let i = 0;
  const api: KycApi = {
    async status() {
      return script[Math.min(i++, script.length - 1)]!;
    },
    async start(tier, key) {
      if (opts.startFails === 'down') throw Object.assign(new Error('down'), { code: 'PROVIDER_UNAVAILABLE', status: 503 });
      if (opts.startFails === 'generic') throw new Error('boom');
      starts.push(key);
      const s: KycSessionStarted = { sessionId: `kyc_${starts.length}`, tier, status: 'pending', reasons: [], startedAt: '2026-11-01T09:00:00Z', expiresAt: '2026-11-08T09:00:00Z', clientToken: `ct_${starts.length}` };
      return s;
    },
  };
  return { api, starts };
}
const session = (status: 'pending' | 'approved' | 'rejected' | 'review', reasons: string[] = []) => ({ sessionId: 'kyc_1', tier: 'T2' as const, status, reasons, startedAt: '2026-11-01T09:00:00Z', expiresAt: '2026-11-08T09:00:00Z' });

describe('KYC view model (M06)', () => {
  it('maps the API status to a screen mode: T2 approved is approved, T1 alone is not', () => {
    expect(kycMode({ status: 'none' })).toBe('none');
    expect(kycMode({ status: 'pending', current: session('pending') })).toBe('pending');
    expect(kycMode({ status: 'approved', approvedTier: 'T1', current: { ...session('approved'), tier: 'T1' } })).toBe('none');
    expect(kycMode({ status: 'approved', approvedTier: 'T2', current: session('approved') })).toBe('approved');
    expect(kycMode({ status: 'review', current: session('review', ['MANUAL_REVIEW']) })).toBe('review');
    expect(reasonCopy('DOCUMENT_MISMATCH')).toEqual({ key: 'kyc.reason.DOCUMENT_MISMATCH', vars: {} });
    expect(reasonCopy('X_99')).toEqual({ key: 'kyc.reason.unknown', vars: { code: 'X_99' } });
  });

  it('starts a session, holds the capture token in memory only, shows pending, then moves to the card once approved', async () => {
    const { api, starts } = fakeKyc([{ status: 'none' }, { status: 'pending', current: session('pending') }, { status: 'approved', approvedTier: 'T2', current: session('approved') }]);
    const router = memoryRouter('/kyc');
    const m = createKycModel({ kyc: api, router, newKey: () => 'key-1' });
    await m.load();
    expect(m.store.get().mode).toBe('none');
    await m.start();
    expect(m.store.get()).toMatchObject({ mode: 'pending', clientToken: 'ct_1', sessionId: 'kyc_1', busy: false });
    expect(starts).toEqual(['key-1']);
    await m.refresh();
    expect(m.store.get().mode).toBe('pending');
    expect(router.current()).toBe('/kyc');
    await m.refresh();
    expect(m.store.get().mode).toBe('approved');
    expect(router.current()).toBe('/card');
  });

  it('a rejection lists the reasons; retry opens a fresh session with a new key', async () => {
    const { api, starts } = fakeKyc([{ status: 'rejected', current: session('rejected', ['DOCUMENT_MISMATCH', 'Q_1']) }]);
    let n = 0;
    const m = createKycModel({ kyc: api, router: memoryRouter(), newKey: () => `key-${++n}` });
    await m.load();
    expect(m.store.get()).toMatchObject({ mode: 'rejected', reasons: [{ key: 'kyc.reason.DOCUMENT_MISMATCH', vars: {} }, { key: 'kyc.reason.unknown', vars: { code: 'Q_1' } }] });
    await m.retry();
    expect(m.store.get()).toMatchObject({ mode: 'pending', reasons: [], sessionId: 'kyc_1', clientToken: 'ct_1' });
    expect(starts).toEqual(['key-1']);
  });

  it('a manual review waits; a partner outage says so and keeps the screen; the approved CTA goes to the card', async () => {
    const review = fakeKyc([{ status: 'review', current: session('review', ['MANUAL_REVIEW']) }]);
    const m = createKycModel({ kyc: review.api, router: memoryRouter(), newKey: () => 'k' });
    await m.load();
    expect(m.store.get()).toMatchObject({ mode: 'review', reasons: [{ key: 'kyc.reason.MANUAL_REVIEW', vars: {} }] });

    const down = fakeKyc([{ status: 'none' }], { startFails: 'down' });
    const router = memoryRouter('/kyc');
    const d = createKycModel({ kyc: down.api, router, newKey: () => 'k' });
    await d.load();
    await d.start();
    expect(d.store.get()).toMatchObject({ mode: 'none', error: 'kyc.unavailable', busy: false });
    d.continueToCard();
    expect(router.current()).toBe('/card');
  });
});

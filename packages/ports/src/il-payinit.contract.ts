// IlPayInitPort contract.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { IlPayInitError, type IlPayInitPort } from './il-payinit.ts';

export interface IlPayInitContractOptions {
  callback: (port: IlPayInitPort, paymentId: string) => Promise<{ headers: Record<string, string>; rawBody: string }>;
  rejectedReference: string;
  outageBankCode?: string;
}

export function ilPayInitContract(name: string, make: () => IlPayInitPort, opts: IlPayInitContractOptions): void {
  describe(`IlPayInitPort contract: ${name}`, () => {
    const input = { amount: money(50_000n, 'ILS'), reference: 'load-1', returnUrl: 'https://app.kesher.example/return' };

    it('initiates idempotently with a redirect and an expiry', async () => {
      const port = make();
      const a = await port.initiate(input, 'i-1');
      const b = await port.initiate(input, 'i-1');
      expect(b.paymentId).toBe(a.paymentId);
      expect(a.status).toBe('redirect');
      expect(a.redirectUrl).toMatch(/^https:\/\//);
      expect(Date.parse(a.expiresAt)).toBeGreaterThan(0);
    });

    it('refuses non-ILS amounts and non-https return urls', async () => {
      const port = make();
      await expect(port.initiate({ ...input, amount: money(1n, 'USD') }, 'i-2')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.initiate({ ...input, returnUrl: 'http://x' }, 'i-3')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('the bank callback settles or rejects, is signed and deduped', async () => {
      const port = make();
      const ok = await port.initiate(input, 'i-4');
      const cb = await opts.callback(port, ok.paymentId);
      const e1 = await port.parseCallback(cb.headers, cb.rawBody);
      const e2 = await port.parseCallback(cb.headers, cb.rawBody);
      expect(e1.payment.status).toBe('settled');
      expect(e2).toEqual(e1);
      const rejected = await port.initiate({ ...input, reference: opts.rejectedReference }, 'i-5');
      const cb2 = await opts.callback(port, rejected.paymentId);
      expect((await port.parseCallback(cb2.headers, cb2.rawBody)).payment.status).toBe('rejected');
      await expect(port.parseCallback({ 'x-sim-signature': 'forged', 'x-signature': 'forged' }, cb.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('unknown payments are typed errors', async () => {
      await expect(make().getStatus('nope')).rejects.toBeInstanceOf(IlPayInitError);
    });

    if (opts.outageBankCode) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().initiate({ ...input, payerHint: { bankCode: opts.outageBankCode! } }, 'i-o')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

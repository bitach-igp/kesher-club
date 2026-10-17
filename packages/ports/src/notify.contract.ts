// NotifyPort contract: every adapter is idempotent, validates recipients per channel, and maps
// provider failures to the closed failureCode set. Recipients never appear in error messages.
import { describe, expect, it } from 'vitest';
import { NotifyError, type Channel, type NotifyPort } from './notify.ts';

export interface NotifyContractOptions {
  channel: Channel;
  goodRecipient: string;
  badRecipient: string;
  bouncingRecipient?: string;
  outageRecipient?: string;
}

export function notifyContract(name: string, make: () => NotifyPort, opts: NotifyContractOptions): void {
  describe(`NotifyPort contract: ${name} (${opts.channel})`, () => {
    const base = { channel: opts.channel, template: 'money.received', locale: 'en' as const, data: { amount: '₪50', from: 'Dani' }, category: 'money' as const };

    it('sends once per idempotency key', async () => {
      const port = make();
      const a = await port.send({ ...base, to: opts.goodRecipient }, 'n-1');
      const b = await port.send({ ...base, to: opts.goodRecipient }, 'n-1');
      expect(b.messageId).toBe(a.messageId);
      expect(['queued', 'sent']).toContain(a.status);
      expect((await port.getDelivery(a.messageId)).messageId).toBe(a.messageId);
    });

    it('rejects a malformed recipient without echoing it', async () => {
      try {
        await make().send({ ...base, to: opts.badRecipient }, 'n-2');
        throw new Error('expected a NotifyError');
      } catch (e) {
        expect(e).toBeInstanceOf(NotifyError);
        expect((e as Error).message).not.toContain(opts.badRecipient);
      }
    });

    it('unknown message ids are typed errors', async () => {
      await expect(make().getDelivery('nope')).rejects.toBeInstanceOf(NotifyError);
    });

    if (opts.bouncingRecipient) {
      it('maps a bounce to a failed delivery with INVALID_RECIPIENT', async () => {
        const d = await make().send({ ...base, to: opts.bouncingRecipient! }, 'n-3');
        expect(d.status).toBe('failed');
        expect(d.failureCode).toBe('INVALID_RECIPIENT');
      });
    }
    if (opts.outageRecipient) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().send({ ...base, to: opts.outageRecipient! }, 'n-4')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

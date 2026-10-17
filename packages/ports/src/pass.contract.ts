// PassPort contract.
import { describe, expect, it } from 'vitest';
import { PassError, type PassPort } from './pass.ts';

export function passContract(name: string, make: () => PassPort, opts: { outageMemberId?: string } = {}): void {
  describe(`PassPort contract: ${name}`, () => {
    const fields = { memberName: 'Noa Levi', institution: 'Yeshivat Example', emergency: '+972-3-000-0000' };

    it('creates a pass idempotently for both platforms with a signed url', async () => {
      const port = make();
      for (const platform of ['apple', 'google'] as const) {
        const a = await port.create({ platform, memberId: 'm1', fields }, `p-${platform}`);
        const b = await port.create({ platform, memberId: 'm1', fields }, `p-${platform}`);
        expect(b.passId).toBe(a.passId);
        expect(a.url).toMatch(/^https:\/\//);
        expect(a.version).toBe(1);
      }
    });

    it('updates bump the version and change the url', async () => {
      const port = make();
      const p = await port.create({ platform: 'apple', memberId: 'm1', fields }, 'p-1');
      const u = await port.update(p.passId, { institution: 'New Yeshiva' }, 'u-1');
      expect(u.version).toBe(2);
      expect(u.url).not.toBe(p.url);
      expect(u.fields['institution']).toBe('New Yeshiva');
      expect(u.fields['memberName']).toBe('Noa Levi');
    });

    it('rejects a pass without the required fields and unknown ids', async () => {
      const port = make();
      await expect(port.create({ platform: 'apple', memberId: 'm1', fields: {} }, 'p-2')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.get('nope')).rejects.toBeInstanceOf(PassError);
    });

    if (opts.outageMemberId) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().create({ platform: 'google', memberId: opts.outageMemberId!, fields }, 'p-o')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

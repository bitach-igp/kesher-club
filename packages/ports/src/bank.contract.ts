// BankPort contract (T-0618). Every adapter:
// - verifies a credit notification and refuses a forged one with BAD_SIGNATURE;
// - answers a repeated notification with the same event and credit;
// - carries the amount as Money, a rail, the bank's reference, the value date and remitter text of at most 140 characters;
// - lists the same credit on its value date's statement, and no other date's;
// - surfaces outages as PROVIDER_UNAVAILABLE.
import { describe, expect, it } from 'vitest';
import { BankError, REMITTER_MAX, type BankPort } from './bank.ts';

export interface BankContractOptions<P extends BankPort> {
  /** Lands a credit at the bank, quoting `remitterReference`, and answers its signed notification. */
  credit(port: P, remitterReference: string): Promise<{ headers: Record<string, string>; rawBody: string }>;
  /** The same notification with its signature broken, the way this provider signs. */
  forge(n: { headers: Record<string, string>; rawBody: string }): { headers: Record<string, string>; rawBody: string };
  /** A value date the provider can be made unavailable for, where one can be forced. */
  outageDate?: string;
}

export function bankContract<P extends BankPort>(name: string, make: () => P, opts: BankContractOptions<P>): void {
  describe(`BankPort contract: ${name}`, () => {
    it('maps a signed notification to its credit, the same way twice', async () => {
      const port = make();
      const n = await opts.credit(port, 'Tuition for November KC-7M4QX2HD');
      const a = await port.parseWebhook(n.headers, n.rawBody);
      expect(a.eventId).toBeTruthy();
      expect(a.credit).toMatchObject({ creditId: expect.any(String), rail: expect.stringMatching(/^(masav|wire|ach)$/), bankReference: expect.any(String), valueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(typeof a.credit.amount.minor).toBe('bigint');
      expect(a.credit.amount.minor > 0n).toBe(true);
      expect(a.credit.remitterReference).toContain('KC-7M4QX2HD');
      expect(await port.parseWebhook(n.headers, n.rawBody)).toEqual(a);
    });

    it('refuses a forged notification with BAD_SIGNATURE', async () => {
      const port = make();
      const n = await opts.credit(port, 'KC-7M4QX2HD');
      const forged = opts.forge(n);
      await expect(port.parseWebhook(forged.headers, forged.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('lists the credit on its value date\'s statement and on no other', async () => {
      const port = make();
      const n = await opts.credit(port, `${'x'.repeat(200)} KC-7M4QX2HD`);
      const { credit } = await port.parseWebhook(n.headers, n.rawBody);
      expect(credit.remitterReference.length).toBeLessThanOrEqual(REMITTER_MAX);
      expect((await port.statement({ valueDate: credit.valueDate })).map((c) => c.creditId)).toContain(credit.creditId);
      expect((await port.statement({ valueDate: '1999-06-01' })).map((c) => c.creditId)).not.toContain(credit.creditId);
    });

    it.skipIf(!opts.outageDate)('surfaces an outage as PROVIDER_UNAVAILABLE', async () => {
      const e = await make().statement({ valueDate: opts.outageDate! }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BankError);
      expect(e).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });
  });
}

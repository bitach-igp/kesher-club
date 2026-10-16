import { describe, expect, it } from 'vitest';
import { ibanChecksumOk } from './payout.ts';
import { payoutContract } from './payout.contract.ts';
import { PayoutSimulator } from './payout.simulator.ts';

// IL62 0108 0000 0009 9999 999 is the IBAN registry's Israeli example.
const IL_IBAN = 'IL620108000000099999999';

payoutContract('simulator', () => new PayoutSimulator(), {
  goodPayee: { iban: IL_IBAN, name: 'Yeshivat Example' },
  failingPayee: { iban: IL_IBAN, name: 'FAIL' },
  outagePayee: { iban: IL_IBAN, name: 'OUTAGE' },
  nextWebhook: async (port, id) => (port as PayoutSimulator).nextWebhook(id),
});

describe('IBAN checksum', () => {
  it('accepts registry examples and rejects a single-digit change', () => {
    expect(ibanChecksumOk(IL_IBAN)).toBe(true);
    expect(ibanChecksumOk('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanChecksumOk('IL620108000000099999998')).toBe(false);
    expect(ibanChecksumOk('')).toBe(false);
  });
});

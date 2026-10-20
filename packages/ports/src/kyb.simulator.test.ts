// T-0622: the KYB simulator passes the KybPort contract, and its fixtures do what its header says.
import { describe, expect, it } from 'vitest';
import { kybContract } from './kyb.contract.ts';
import { KybSimulator } from './kyb.simulator.ts';

kybContract('simulator', () => new KybSimulator(), {
  active: { market: 'IL', identifier: '580123456', name: 'Yeshivat Example' },
  sanctionedName: 'Sanctioned Person Example',
  outageIdentifier: { market: 'IL', identifier: '580123999' },
});

describe('KybSimulator fixtures', () => {
  const sim = new KybSimulator();
  it('struck off, another name, no exempt record, revoked', async () => {
    expect(await sim.lookupEntity({ market: 'IL', identifier: '580123000', name: 'X' })).toMatchObject({ status: 'struck_off' });
    expect(await sim.lookupEntity({ market: 'IL', identifier: '580123111', name: 'X' })).toMatchObject({ status: 'active', nameMatches: false, registeredName: 'Another Registered Name' });
    expect(await sim.exemptStatus({ market: 'US', identifier: '12-3456222' })).toMatchObject({ status: 'not_found', possibleChurch: true });
    expect(await sim.exemptStatus({ market: 'IL', identifier: '580123444' })).toMatchObject({ status: 'revoked' });
  });
  it('an amuta number is an amuta, a 51 number a public-benefit company, an EIN a nonprofit corporation; ניהול תקין for the clock\'s year', async () => {
    expect((await sim.lookupEntity({ market: 'IL', identifier: '580123456', name: 'A' })).entityType).toBe('amuta');
    expect((await sim.lookupEntity({ market: 'IL', identifier: '510123456', name: 'B' })).entityType).toBe('public_benefit_company');
    expect((await sim.lookupEntity({ market: 'US', identifier: '12-3456789', name: 'C' })).entityType).toBe('nonprofit_corporation');
    expect((await sim.exemptStatus({ market: 'IL', identifier: '580123456' })).properManagementYear).toBe(sim.clock.now().getUTCFullYear());
  });
  it('a PEP is a pep match, separate from sanctions', async () => {
    const [r] = await sim.screen({ names: ['Exposed Council Member'] });
    expect(r!.matches.map((m) => m.kind)).toEqual(['pep']);
  });
});

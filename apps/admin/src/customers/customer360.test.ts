import { describe, expect, it } from 'vitest';
import { memoryAdminData } from '../data/memory.ts';
import { customer360, maskEmail, maskPhone } from './customer360.ts';

const now = new Date('2026-11-01T09:00:00Z');

describe('Customer 360 (T-0901)', () => {
  it('masks contact details and never carries a PAN', async () => {
    const data = memoryAdminData();
    const [first] = await data.searchCustomers('noa');
    const c = await data.getCustomer(first!.partyId);
    const v = customer360(c!, now);
    expect(v.phoneMasked).toBe('•••• 4567');
    expect(v.emailMasked).toBe('n••@example.com');
    expect(JSON.stringify(v)).not.toContain('+972501234567');
    expect(maskPhone('+12125550123')).toBe('•••• 0123');
    expect(maskPhone('junk')).toBe('••••');
    expect(maskEmail(undefined)).toBeUndefined();
  });

  it('summarises balances as the member sees them (available) and with holds added (total), lists only open cases and active grants, and raises flags', async () => {
    const data = memoryAdminData();
    const [noa] = await data.searchCustomers('+97250');
    const c = (await data.getCustomer(noa!.partyId))!;
    c.restrictedUntil = '2026-11-02T00:00:00Z';
    c.cards[0]!.status = 'frozen';
    c.grants.push({ id: 'g-old', clientName: 'Old Bot', scopes: ['balances:read'], revokedAt: '2026-10-01T00:00:00Z' });
    const v = customer360(c, now);
    expect(v.balances).toEqual([
      { id: 'acc-usd', currency: 'USD', available: '$125.50', holds: '$0.00', total: '$125.50' },
      { id: 'acc-ils', currency: 'ILS', available: '₪340.00', holds: '₪25.00', total: '₪365.00' },
    ]);
    expect(v.flags).toEqual(['recovery_hold', 'card_frozen', 'open_case']);
    expect(v.openCases.map((k) => k.id)).toEqual(['case-1']);
    expect(v.activeGrants.map((g) => g.id)).toEqual(['grant-1']);
    expect(v.audit[0]?.action).toBe('card.unfrozen');
  });

  it('search matches name, phone, email or id and returns summaries only', async () => {
    const data = memoryAdminData();
    expect((await data.searchCustomers('dana@example.com')).map((c) => c.displayName)).toEqual(['Dana Example']);
    expect(await data.searchCustomers('nobody')).toEqual([]);
    expect(Object.keys((await data.searchCustomers(''))[0]!)).not.toContain('accounts');
  });
});

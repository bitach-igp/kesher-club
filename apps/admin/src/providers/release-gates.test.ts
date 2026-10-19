import { describe, expect, it } from 'vitest';
import { memoryAdminData } from '../data/memory.ts';
import { AdminDataError } from '../data/types.ts';
import { providerRows } from './bindings.ts';
import { evaluateFlip, gatesFor } from './release-gates.ts';

const now = new Date('2026-11-01T09:00:00Z');
const ops1 = { subject: 'admin:ops-1', roles: ['ops'] };
const ops2 = { subject: 'admin:ops-2', roles: ['ops'] };

describe('release gates (T-0902)', () => {
  it('money flags carry the pentest and bank-disclosure gates on top of the eight common ones', () => {
    expect(gatesFor('esim.airalo').map((g) => g.id)).toEqual(['tests', 'contract7', 'security', 'disclosures', 'runbook', 'analytics', 'staff7', 'pilot14']);
    expect(gatesFor('wallet.enabled').map((g) => g.id)).toContain('pentest');
    expect(gatesFor('p2p.enabled').map((g) => g.id)).toContain('bankDisclosures');
  });

  it('a flip to on is ready only with every gate ticked and two distinct approvers; off never waits on gates', () => {
    const all = gatesFor('esim.airalo').map((g) => g.id);
    expect(evaluateFlip('esim.airalo', all.slice(0, 7), ['a', 'b'])).toMatchObject({ gatesComplete: false, missing: ['pilot14'], ready: false });
    expect(evaluateFlip('esim.airalo', all, ['a', 'a'])).toMatchObject({ gatesComplete: true, approvals: 1, ready: false });
    expect(evaluateFlip('esim.airalo', all, ['a', 'b'])).toMatchObject({ ready: true });
    expect(evaluateFlip('wallet.enabled', [], ['a', 'b'], false)).toMatchObject({ gatesComplete: true, ready: true });
  });

  it('two-person flip: propose, a different admin approves, the flag turns on and the audit log says who', async () => {
    const data = memoryAdminData();
    for (const g of gatesFor('esim.airalo')) await data.tickGate('esim.airalo', g.id, true, ops1, now);
    await data.proposeFlip('esim.airalo', true, ops1, now);
    await expect(data.approveFlip('esim.airalo', ops1, now)).rejects.toBeInstanceOf(AdminDataError);
    const f = await data.approveFlip('esim.airalo', ops2, now);
    expect(f).toMatchObject({ on: true, pendingFlip: undefined, lastChangedBy: 'admin:ops-1+admin:ops-2' });
    const log = await data.auditLog();
    expect(log[0]).toMatchObject({ actor: 'admin:ops-2', action: 'flag.flip.applied', subject: 'esim.airalo' });
  });

  it('a flip to on with unticked gates is refused at proposal; the kill switch is immediate and single-person', async () => {
    const data = memoryAdminData();
    await expect(data.proposeFlip('insurance.coverGenius', true, ops1, now)).rejects.toMatchObject({ code: 'GATES_INCOMPLETE' });
    expect((await data.getFlag('billing.stripe'))?.on).toBe(true);
    const off = await data.killSwitch('billing.stripe', ops1, now);
    expect(off).toMatchObject({ on: false, lastChangedBy: 'admin:ops-1' });
    expect((await data.auditLog())[0]).toMatchObject({ action: 'flag.kill_switch', subject: 'billing.stripe' });
  });

  it('provider rows show the binding, gate progress and a status per port in each market (T-0913)', async () => {
    const data = memoryAdminData();
    const rows = providerRows(await data.listBindings(), await data.listFlags());
    expect(rows).toHaveLength(36);
    const billing = rows.find((r) => r.capability === 'billing' && r.market === 'IL')!;
    expect(billing).toMatchObject({ binding: 'stripe', status: 'live', contractGreenNights: 9 });
    // Flags are club-wide, so both markets' rows show billing.stripe on; the US still binds the simulator, so
    // its row says so instead of live (T-0916).
    const us = rows.find((r) => r.capability === 'billing' && r.market === 'US')!;
    expect(us).toMatchObject({ binding: 'simulator', status: 'simulator', contractGreenNights: 0 });
    expect(us.flags).toContainEqual(expect.objectContaining({ key: 'billing.stripe', on: true }));
    const esim = rows.find((r) => r.capability === 'esim' && r.market === 'IL')!;
    expect(esim).toMatchObject({ binding: 'simulator', status: 'simulator', flags: [expect.objectContaining({ key: 'esim.airalo', on: false, gatesTicked: 0, gatesTotal: 8 }), expect.anything()] });
  });
});

// Card controls (T-0404, REQ-CRD-005): validation, the funder's lock, the member's refusal with a
// reason, release, and the agent-purchases key that only the funder may set.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { applyPatch, patchedKeys, validatePatch } from './controls.ts';
import { DEFAULT_VIRTUAL_CONTROLS } from './service.ts';

const base = DEFAULT_VIRTUAL_CONTROLS;

describe('validatePatch', () => {
  it('accepts the contract shapes and rejects the rest with the field named', () => {
    expect(() => validatePatch({ dailyLimit: { minor: '50000', currency: 'ILS' }, blockedMccs: ['7995'], allowedCountries: ['IL'], atm: false, online: true })).not.toThrow();
    expect(() => validatePatch({ dailyLimit: { minor: '0', currency: 'ILS' } })).toThrow(/dailyLimit must be positive/);
    expect(() => validatePatch({ monthlyLimit: { minor: '1.5', currency: 'ILS' } })).toThrow(/monthlyLimit must be money/);
    expect(() => validatePatch({ blockedMccs: ['799'] })).toThrow(/four-digit/);
    expect(() => validatePatch({ allowedCountries: ['Israel'] })).toThrow(/alpha-2/);
    expect(() => validatePatch({ atm: 'no' as unknown as boolean })).toThrow(/atm must be a boolean/);
    expect(() => validatePatch({ nope: true } as never)).toThrow(/Unknown control nope/);
    expect(() => validatePatch({ agentPurchases: { mode: 'under_amount' } })).toThrow(/underAmount is required/);
    expect(() => validatePatch({ agentPurchases: { mode: 'sometimes' as never } })).toThrow(/mode must be/);
    expect(() => validatePatch({ release: ['pin'] })).toThrow(/release must name control keys/);
  });

  it('lists the keys a patch sets, counting null as a clear', () => {
    expect(patchedKeys({ dailyLimit: null, atm: true, release: ['online'] })).toEqual(['dailyLimit', 'atm']);
  });
});

describe('applyPatch (TST-CRD-005)', () => {
  it('a funder patch applies and locks the keys it sets', () => {
    const r = applyPatch(base, [], { dailyLimit: { minor: '50000', currency: 'ILS' }, blockedMccs: ['7995', '7995'], atm: false }, 'funder');
    expect(r.controls).toEqual({ ...base, dailyLimit: money(50_000n, 'ILS'), blockedMccs: ['7995'], atm: false });
    expect(r.lockedByFunder.sort()).toEqual(['atm', 'blockedMccs', 'dailyLimit']);
    expect(r.changed.sort()).toEqual(['atm', 'blockedMccs', 'dailyLimit']);
  });

  it('a member may change unlocked keys and is refused on locked ones, with the keys in the reason', () => {
    const locked = ['dailyLimit', 'blockedMccs'];
    const ok = applyPatch(base, locked, { online: false, allowedCountries: ['IL', 'US'] }, 'member');
    expect(ok.controls).toMatchObject({ online: false, allowedCountries: ['IL', 'US'] });
    expect(ok.lockedByFunder).toEqual(locked);
    let err: unknown;
    try {
      applyPatch(base, locked, { dailyLimit: { minor: '1', currency: 'ILS' }, online: true }, 'member');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: 'Set by your funder: dailyLimit. Ask them to change it.' });
    expect((err as { extra?: unknown }).extra ?? (err as { details?: unknown }).details).toBeDefined();
    expect(() => applyPatch(base, [], { release: ['dailyLimit'] }, 'member')).toThrow(/Only the funder releases/);
  });

  it('agent purchases belong to the funder; a member is refused even when nothing is locked', () => {
    expect(() => applyPatch(base, [], { agentPurchases: { mode: 'with_approval' } }, 'member')).toThrow(/set by your funder/i);
    const r = applyPatch(base, [], { agentPurchases: { mode: 'under_amount', underAmount: { minor: '2500', currency: 'USD' } } }, 'funder');
    expect(r.controls.agentPurchases).toEqual({ underMinor: 2_500n });
    expect(r.lockedByFunder).toEqual(['agentPurchases']);
  });

  it('a funder releases keys and clears limits with null; the member can then change them', () => {
    const locked = applyPatch({ ...base, dailyLimit: money(5_000n, 'ILS') }, ['dailyLimit', 'atm'], { dailyLimit: null, release: ['atm'] }, 'funder');
    expect(locked.controls.dailyLimit).toBeUndefined();
    expect(locked.lockedByFunder).toEqual(['dailyLimit']);
    expect(locked.changed.sort()).toEqual(['atm', 'dailyLimit']);
    expect(applyPatch(locked.controls, locked.lockedByFunder, { atm: true }, 'member').controls.atm).toBe(true);
  });
});

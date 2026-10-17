// Card controls (T-0404, REQ-CRD-005): the funder's settings override the member's. A key the funder
// sets is locked: the member sees it in lockedByFunder and a member PATCH on it is FORBIDDEN with the
// reason. The funder may hand a key back by patching it again (a funder patch always owns the keys it
// names; a key the funder stops naming stays locked until released explicitly). Pure functions; the
// service persists the result and tells the processor.
import { DomainError, fromWire, type Money } from '@kesher/domain';
import type { CardControls } from '@kesher/ports';

export const CONTROL_KEYS = ['dailyLimit', 'monthlyLimit', 'blockedMccs', 'allowedCountries', 'atm', 'online', 'agentPurchases'] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];
export type Actor = 'member' | 'funder';

/** CardControlsPatch on the wire, plus agentPurchases (REQ-CRD-008, funder only) and `release` for a funder handing keys back. */
export interface ControlsPatch {
  dailyLimit?: { minor: string; currency: string } | null;
  monthlyLimit?: { minor: string; currency: string } | null;
  blockedMccs?: string[];
  allowedCountries?: string[] | null;
  atm?: boolean;
  online?: boolean;
  agentPurchases?: { mode: 'off' | 'with_approval' | 'under_amount'; underAmount?: { minor: string; currency: string } };
  /** Funder only: keys to unlock for the member. */
  release?: string[];
}

const MCC = /^\d{4}$/;
const COUNTRY = /^[A-Z]{2}$/;

const isKey = (k: string): k is ControlKey => (CONTROL_KEYS as readonly string[]).includes(k);

/** Keys the patch sets (null counts: it clears a limit). */
export function patchedKeys(patch: ControlsPatch): ControlKey[] {
  return Object.keys(patch).filter((k): k is ControlKey => isKey(k) && patch[k] !== undefined);
}

const positive = (m: { minor: string; currency: string }, what: string): Money => {
  let money: Money;
  try {
    money = fromWire(m);
  } catch {
    throw new DomainError('VALIDATION_FAILED', `${what} must be money with an integer minor amount in USD or ILS`);
  }
  if (money.minor <= 0n) throw new DomainError('VALIDATION_FAILED', `${what} must be positive`);
  return money;
};

/** Checks every field of a patch; throws VALIDATION_FAILED with the first problem. */
export function validatePatch(patch: ControlsPatch): void {
  for (const k of Object.keys(patch)) if (!isKey(k) && k !== 'release') throw new DomainError('VALIDATION_FAILED', `Unknown control ${k}`);
  if (patch.dailyLimit) positive(patch.dailyLimit, 'dailyLimit');
  if (patch.monthlyLimit) positive(patch.monthlyLimit, 'monthlyLimit');
  if (patch.blockedMccs !== undefined && (!Array.isArray(patch.blockedMccs) || patch.blockedMccs.some((m) => typeof m !== 'string' || !MCC.test(m)))) throw new DomainError('VALIDATION_FAILED', 'blockedMccs must be four-digit codes');
  if (patch.allowedCountries != null && (!Array.isArray(patch.allowedCountries) || patch.allowedCountries.some((c) => typeof c !== 'string' || !COUNTRY.test(c)))) throw new DomainError('VALIDATION_FAILED', 'allowedCountries must be ISO 3166 alpha-2 codes');
  if (patch.atm !== undefined && typeof patch.atm !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'atm must be a boolean');
  if (patch.online !== undefined && typeof patch.online !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'online must be a boolean');
  if (patch.agentPurchases !== undefined) {
    const a = patch.agentPurchases;
    if (!a || !['off', 'with_approval', 'under_amount'].includes(a.mode)) throw new DomainError('VALIDATION_FAILED', 'agentPurchases.mode must be off, with_approval or under_amount');
    if (a.mode === 'under_amount') {
      if (!a.underAmount) throw new DomainError('VALIDATION_FAILED', 'agentPurchases.underAmount is required for under_amount');
      positive(a.underAmount, 'agentPurchases.underAmount');
    }
  }
  if (patch.release !== undefined && (!Array.isArray(patch.release) || patch.release.some((k) => !isKey(k)))) throw new DomainError('VALIDATION_FAILED', 'release must name control keys');
}

export interface Applied {
  controls: CardControls;
  lockedByFunder: ControlKey[];
  /** Keys this patch changed or released. */
  changed: ControlKey[];
}

/**
 * Applies a validated patch for `by`. A member may not touch a locked key (FORBIDDEN, naming the keys
 * and who locked them). A funder's patch locks the keys it sets and releases the keys it names in
 * `release`. agentPurchases is the funder's alone (REQ-CRD-008).
 */
export function applyPatch(current: CardControls, locked: readonly string[], patch: ControlsPatch, by: Actor): Applied {
  validatePatch(patch);
  const keys = patchedKeys(patch);
  if (by === 'member') {
    const blocked = keys.filter((k) => locked.includes(k));
    if (blocked.length) throw new DomainError('FORBIDDEN', `Set by your funder: ${blocked.join(', ')}. Ask them to change it.`, { lockedByFunder: blocked });
    if (keys.includes('agentPurchases')) throw new DomainError('FORBIDDEN', 'Agent purchases are set by your funder.', { lockedByFunder: ['agentPurchases'] });
    if (patch.release?.length) throw new DomainError('FORBIDDEN', 'Only the funder releases a control.');
  }
  const next: CardControls = { ...current };
  if (patch.dailyLimit !== undefined) {
    if (patch.dailyLimit === null) delete next.dailyLimit;
    else next.dailyLimit = fromWire(patch.dailyLimit);
  }
  if (patch.monthlyLimit !== undefined) {
    if (patch.monthlyLimit === null) delete next.monthlyLimit;
    else next.monthlyLimit = fromWire(patch.monthlyLimit);
  }
  if (patch.blockedMccs !== undefined) next.blockedMccs = [...new Set(patch.blockedMccs)];
  if (patch.allowedCountries !== undefined) {
    if (patch.allowedCountries === null) delete next.allowedCountries;
    else next.allowedCountries = [...new Set(patch.allowedCountries)];
  }
  if (patch.atm !== undefined) next.atm = patch.atm;
  if (patch.online !== undefined) next.online = patch.online;
  if (patch.agentPurchases !== undefined) {
    const a = patch.agentPurchases;
    next.agentPurchases = a.mode === 'under_amount' ? { underMinor: fromWire(a.underAmount!).minor } : a.mode;
  }
  const released = (patch.release ?? []).filter(isKey);
  const lockedNext = by === 'funder' ? [...new Set([...locked.filter((k) => !released.includes(k as ControlKey)), ...keys])] : [...locked];
  return { controls: next, lockedByFunder: lockedNext.filter(isKey), changed: [...new Set([...keys, ...released])] };
}

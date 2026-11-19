// The wallet feature flag and its one gate. loads.ts keeps its own copy of the constant and the check (money path).
import { DomainError } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';

export const WALLET_FLAG = 'wallet.enabled';

/** Throws FEATURE_OFF unless the wallet flag is on (for the party, when a context is given). */
export async function requireWalletOn(flags: Pick<FeatureFlags, 'isOn'>, context?: { partyId?: string }): Promise<void> {
  const on = context === undefined ? await flags.isOn(WALLET_FLAG) : await flags.isOn(WALLET_FLAG, context);
  if (!on) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
}

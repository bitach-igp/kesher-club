// The KYB gate (T-0621, REQ-INS-010, ADR-017): which of an institution's money capabilities its current KYB
// decision opens. Each service that moves an institution's money asks here first:
// - deposit posting;
// - allowance runs, inside the credit lock;
// - setting and drawing on a credit line;
// - payouts.
// A closed capability answers FEATURE_OFF naming the status, so the console can say what is missing.
//
// An open sanctions match (T-0624, REQ-INS-013) suspends payouts and credit draws on top of that, whatever the
// status, until compliance disposes of it. The institution's own money keeps flowing to its members:
// deposits and allowances within the balance stay open.
import { DomainError } from '@kesher/domain';
import type { SqlClient } from '../db.ts';
import type { InstitutionKyb, KybStatus } from './kyb.ts';

export type Capability = 'deposits' | 'allowances' | 'credit' | 'payouts';

/** ADR-017's table. Approved with limits runs on the institution's own money only: no credit. */
export const OPEN: Readonly<Record<KybStatus, readonly Capability[]>> = {
  needs_more_info: [],
  approved_with_limits: ['deposits', 'allowances', 'payouts'],
  approved: ['deposits', 'allowances', 'credit', 'payouts'],
  rejected: [],
};

/** What an open sanctions match suspends. */
export const SUSPENDED_BY_MATCH: readonly Capability[] = ['credit', 'payouts'];

export class KybGate {
  private readonly kyb: Pick<InstitutionKyb, 'current' | 'openSanctionsMatches'>;
  constructor(kyb: Pick<InstitutionKyb, 'current' | 'openSanctionsMatches'>) {
    this.kyb = kyb;
  }

  async allows(institutionId: string, capability: Capability, client?: SqlClient): Promise<boolean> {
    return !(await this.refusal(institutionId, capability, client));
  }

  async require(institutionId: string, capability: Capability, client?: SqlClient): Promise<void> {
    const refused = await this.refusal(institutionId, capability, client);
    if (refused) throw refused;
  }

  private async refusal(institutionId: string, capability: Capability, client?: SqlClient): Promise<DomainError | undefined> {
    const { status } = await this.kyb.current(institutionId, client);
    if (!OPEN[status].includes(capability)) return new DomainError('FEATURE_OFF', `The institution's KYB is ${status.replace(/_/g, ' ')}: ${capability} are not open yet`, { kyb: status, capability });
    if (!SUSPENDED_BY_MATCH.includes(capability)) return undefined;
    const matches = await this.kyb.openSanctionsMatches(institutionId, client);
    if (matches.length) return new DomainError('FEATURE_OFF', `A potential sanctions match is open: ${capability} are suspended until compliance reviews it`, { kyb: status, capability, sanctionsMatches: matches });
    return undefined;
  }
}

// The KYB gate (T-0621, REQ-INS-010, ADR-017): which of an institution's money capabilities its current KYB
// decision opens. Each service that moves an institution's money asks here first:
// - deposit posting;
// - allowance runs, inside the credit lock;
// - setting and drawing on a credit line;
// - payouts.
// A closed capability answers FEATURE_OFF naming the status, so the console can say what is missing.
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

export class KybGate {
  private readonly kyb: Pick<InstitutionKyb, 'current'>;
  constructor(kyb: Pick<InstitutionKyb, 'current'>) {
    this.kyb = kyb;
  }

  async allows(institutionId: string, capability: Capability, client?: SqlClient): Promise<boolean> {
    return OPEN[(await this.kyb.current(institutionId, client)).status].includes(capability);
  }

  async require(institutionId: string, capability: Capability, client?: SqlClient): Promise<void> {
    const { status } = await this.kyb.current(institutionId, client);
    if (!OPEN[status].includes(capability)) throw new DomainError('FEATURE_OFF', `The institution's KYB is ${status.replace(/_/g, ' ')}: ${capability} are not open yet`, { kyb: status, capability });
  }
}

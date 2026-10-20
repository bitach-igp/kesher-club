// Tests only (T-0621): an institution's KYB decision recorded as compliance would leave it, so a test of
// deposits, allowances, credit or payouts starts from an institution the gate (ADR-017) lets through.
import { uuidv7 } from '@kesher/domain';
import type { SqlClient } from './db.ts';
import type { KybStatus, Risk } from './institutions/kyb.ts';

export async function decideKyb(db: SqlClient, institutionId: string, status: KybStatus = 'approved', risk: Risk = 'low'): Promise<void> {
  await db.query(`insert into org.kyb_decision (id, institution_id, status, risk, reasons, decided_by, decided_at) values ($1, $2, $3, $4, $5, $6, now())`, [uuidv7(), institutionId, status, status === 'approved' || status === 'approved_with_limits' ? risk : null, ['test fixture'], uuidv7()]);
}

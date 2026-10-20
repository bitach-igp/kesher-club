// Tests only: what compliance would leave behind, so a test of deposits, allowances, credit or payouts starts
// from an institution the gates let through. T-0621 needs the KYB decision (ADR-017); T-0623 needs the
// approved own-name payout account.
import { uuidv7 } from '@kesher/domain';
import type { SqlClient } from './db.ts';
import type { KybStatus, Risk } from './institutions/kyb.ts';

export async function decideKyb(db: SqlClient, institutionId: string, status: KybStatus = 'approved', risk: Risk = 'low'): Promise<void> {
  await db.query(`insert into org.kyb_decision (id, institution_id, status, risk, reasons, decided_by, decided_at) values ($1, $2, $3, $4, $5, $6, now())`, [uuidv7(), institutionId, status, status === 'approved' || status === 'approved_with_limits' ? risk : null, ['test fixture'], uuidv7()]);
}

/** An approved own-name payout account (T-0623), as two compliance members would leave it. */
export async function verifiedPayoutAccount(db: SqlClient, institutionId: string, iban = 'IL620108000000099999999'): Promise<void> {
  const id = uuidv7();
  await db.query(`insert into org.payout_account (id, institution_id, idempotency_key, currency, iban, holder_name, evidence_ref, recorded_by, recorded_at) values ($1, $2, $3, 'ILS', $4, 'Test institution', 'test fixture', $5, now())`, [id, institutionId, `fixture-${id}`, iban, uuidv7()]);
  await db.query(`insert into org.payout_account_approval (account_id, approved_by, approved_at) values ($1, $2, now())`, [id, uuidv7()]);
}

// Production bootstrap core (T-0046): what a fresh staging or production database needs before the first request and that no
// migration, flow or console screen can create. It only inserts what is missing; the row's own unique key is its idempotency key
// (ledger.account: owner, type, currency), so a second run creates nothing. `run` is pure of process state: the caller passes the
// database and the environment name, so tests drive it on PGlite and `index.ts` binds node-postgres.
//
// No audit entry: the task's own log line per account is the record of a one-off run. (AuditService.record used to take a table lock
// that club_app cannot take; since T-0071 it uses an advisory lock, so that is no longer the reason.)
//
// What it does NOT do, and why (docs/setup/bootstrap.md):
//   - the first Kesher admin: a Kesher admin has no database account (staff sign in by SSO and the API verifies a console token),
//     and the T-0924 staff_grant approval grants a signed-up member a role at an institution. Nothing in the code can hold an
//     "admin invite", so none is created. The address is validated and reported masked, nothing is stored.
//   - legal documents: legal.document_version has no draft state, a row is published at once; placeholder text would go live.
//   - plans: an empty billing.plan is the catalogue the A13 propose/approve flow starts from; prices are finance's to enter.
import type { Database } from '../db.ts';
import { CURRENCIES, ensureAccountRowReport, SYSTEM_OWNER, type AccountType } from '../ledger/accounts.ts';

/** Environments the bootstrap runs in. `development`, `test` and `preview` use the demo seed (T-0032); anything else is refused. */
export const BOOTSTRAP_ENVS = ['staging', 'prod'] as const;

/**
 * Every system account kind the code reads or posts to (`systemAccount(` / `findSystemAccount(` in apps/api/src):
 * fx_position, fee_income (FX, p2p, loads, closure, card authorisation and settlement, add-on orders), partner_settlement
 * (deposits, loads, closure, card settlement, payouts) and addon_payable (add-on orders). suspense is an ops case kind and
 * payout_reserve and institution_master are per institution, so no system account of those kinds exists; interchange_income is
 * in the enum but nothing posts to it. A kind added to the code is added here, and the test lists the source to catch it.
 */
export const BOOTSTRAP_SYSTEM_ACCOUNTS = ['fx_position', 'fee_income', 'partner_settlement', 'addon_payable'] as const satisfies readonly Exclude<AccountType, 'wallet' | 'pending'>[];

export interface BootstrapOptions {
  appEnv: string | undefined;
  /** The would-be first admin, from the command line. Validated and reported masked; nothing is stored (see the header). */
  adminEmail?: string | undefined;
}

export interface BootstrapReport {
  created: string[];
  existing: string[];
  /** Read-only observations and the steps this command does not take. */
  notes: string[];
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `a***@d***.com`: enough to tell a typo from the intended address, never the address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return `${email[0] ?? ''}***@${domain[0] ?? ''}***${dot >= 0 ? domain.slice(dot) : ''}`;
}

export function assertBootstrapEnv(appEnv: string | undefined): asserts appEnv is (typeof BOOTSTRAP_ENVS)[number] {
  if (!(BOOTSTRAP_ENVS as readonly (string | undefined)[]).includes(appEnv)) {
    throw new BootstrapError(`refused: APP_ENV must be one of ${BOOTSTRAP_ENVS.join(', ')} (got ${appEnv ? JSON.stringify(appEnv) : 'nothing'}); the demo seed is for the other environments`);
  }
}

export async function run(db: Database, opts: BootstrapOptions): Promise<BootstrapReport> {
  assertBootstrapEnv(opts.appEnv);
  if (opts.adminEmail !== undefined && !EMAIL.test(opts.adminEmail)) throw new BootstrapError('refused: --admin-email is not an e-mail address');
  const report: BootstrapReport = { created: [], existing: [], notes: [] };

  for (const type of BOOTSTRAP_SYSTEM_ACCOUNTS) {
    for (const currency of CURRENCIES) {
      // The (owner, type, currency) unique key is the idempotency key; of two racing runs exactly one inserts and reports it.
      const { created } = await ensureAccountRowReport(db, SYSTEM_OWNER, type, currency);
      (created ? report.created : report.existing).push(`system account ${type} ${currency}`);
    }
  }
  if (opts.adminEmail !== undefined) {
    report.notes.push(`first admin ${maskEmail(opts.adminEmail)}: NOT created. A Kesher admin signs in by SSO and has no database account to invite; see docs/setup/bootstrap.md`);
  }
  const docs = await db.query<{ doc_key: string }>('select distinct doc_key from legal.document_version');
  report.notes.push(`legal: ${docs.rows.length} of 7 document kinds have a version; nothing created (no draft state), enter the text in the console`);
  const plans = await db.query<{ n: string }>('select count(*)::text as n from billing.plan');
  report.notes.push(`plans: ${plans.rows[0]?.n ?? '0'} in the catalogue; nothing created (prices go through the A13 propose/approve flow)`);
  return report;
}

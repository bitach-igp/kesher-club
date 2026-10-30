// US institutions pull USD by ACH (T-0617, REQ-INS-009): the institution's finance staff pull from the
// institution's bank account through the FundingPort's ACH method. It is the member ACH load of flow 2 with the
// institution as payer and payee (`runLoad`, a transfer of kind 'deposit'), so the vendor's webhook, the release
// job and a return all apply unchanged. The money waits in the institution's hold account until the bank's hold
// date, then lands in its own account; an ACH return during the hold reverses it. Payouts and allowance runs read
// the institution's own account only, so held money is never their headroom.
import { DomainError, fromWire, toWire, type Money } from '@kesher/domain';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { AuditService } from '../audit/service.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';
import { ACH_FLAG, loadState, runLoad, type LoadService, type LoadState } from '../wallet/loads.ts';
import { DEPOSITS_FLAG } from './deposits.ts';
import type { KybGate } from './kyb-gate.ts';

/** The workflow id, and the vendor pull's key: one per institution and Idempotency-Key. */
export const pullKey = (institutionId: string, key: string): string => `ach-pull:${institutionId}:${key}`;
const PAGE = 50;

/** The OpenAPI `InstitutionAchPull`. */
export interface AchPullView {
  id: string;
  state: LoadState;
  amount: ReturnType<typeof toWire>;
  /** While held: the bank's hold date, when the money becomes the institution's to spend. */
  holdUntil?: string;
  failureCode?: string;
  createdAt: string;
}

export interface AchPullDeps {
  db: Database;
  loads: LoadService;
  transfers: TransferService;
  accounts: AccountService;
  flags: FeatureFlags;
  kyb: KybGate;
  audit: AuditService;
}

const view = (t: Transfer): AchPullView => ({
  id: t.id,
  state: loadState(t),
  amount: toWire(t.amount),
  ...(t.state === 'pending_hold' && t.holdReleasesAt ? { holdUntil: t.holdReleasesAt.slice(0, 10) } : {}),
  ...(t.failureCode ? { failureCode: t.failureCode } : {}),
  createdAt: t.createdAt,
});

export class InstitutionAch {
  private readonly d: AchPullDeps;
  constructor(d: AchPullDeps) {
    this.d = d;
  }

  /** Both switches: bank pulls (`funding.ach`) and institution deposits (`institutions.deposits`). */
  async gate(): Promise<void> {
    if (!(await this.d.flags.isOn(ACH_FLAG)) || !(await this.d.flags.isOn(DEPOSITS_FLAG))) throw new DomainError('FEATURE_OFF', 'ACH pulls are not enabled yet');
  }

  /** Pulls USD from the institution's bank. A replay with the same key is the same pull; the first is audited. */
  async pull(institutionId: string, by: { partyId: string }, body: unknown, key: string, now: Date): Promise<AchPullView> {
    await this.gate();
    const market = (await this.d.db.query<{ market: string }>('select market from org.institution where id = $1', [institutionId])).rows[0]?.market;
    if (market !== 'US') throw new DomainError('VALIDATION_FAILED', 'ACH pulls are for US institutions', { reason: 'not_us_institution' });
    const { amount, paymentMethodId } = parse(body);
    await this.d.kyb.require(institutionId, 'deposits');
    const workflowId = pullKey(institutionId, key);
    if (!(await this.d.transfers.byKey(workflowId))) {
      await this.d.audit.record({ actorId: by.partyId, actorRole: 'org_finance', action: 'institution.ach_pull', subject: `institution:${institutionId}`, reason: 'ACH pull from the institution\'s bank', after: { amount: toWire(amount) }, payload: { workflowId } }, now);
    }
    const run = await runLoad(this.d.loads, { payerPartyId: institutionId, memberPartyId: institutionId, method: 'ach', amount, kind: 'deposit', ...(paymentMethodId ? { paymentMethodId } : {}) }, workflowId, now);
    return view(run.transfer);
  }

  /** The institution's pulls, newest first, with what is on hold and what is its own to spend. */
  async list(institutionId: string): Promise<{ items: AchPullView[]; held: Money; available: Money }> {
    await this.gate();
    // The prefix is fixed and an institution id holds no LIKE wildcard: the client's key cannot widen the match.
    const r = await this.d.db.query<{ id: string }>(`select id from ops.transfer where kind = 'deposit' and to_party_id = $1 and idempotency_key like $2 order by created_at desc, id desc limit ${PAGE}`, [institutionId, `${pullKey(institutionId, '')}%`]);
    const items: AchPullView[] = [];
    for (const row of r.rows) {
      const t = await this.d.transfers.get(row.id);
      if (t) items.push(view(t));
    }
    return { items, held: await this.d.accounts.institutionHolds(institutionId, 'USD'), available: await this.d.accounts.institutionBalance(institutionId, 'USD') };
  }
}

function parse(body: unknown): { amount: Money; paymentMethodId?: string } {
  const b = (body ?? {}) as { amount?: unknown; paymentMethodId?: unknown };
  let amount: Money;
  try {
    amount = fromWire(b.amount as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency } in USD');
  }
  if (amount.currency !== 'USD') throw new DomainError('VALIDATION_FAILED', 'ACH moves dollars: amount must be in USD');
  if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
  if (b.paymentMethodId !== undefined && (typeof b.paymentMethodId !== 'string' || !b.paymentMethodId || b.paymentMethodId.length > 100)) throw new DomainError('VALIDATION_FAILED', 'paymentMethodId must be the bank account the institution linked');
  return { amount, ...(typeof b.paymentMethodId === 'string' ? { paymentMethodId: b.paymentMethodId } : {}) };
}

/** A party's active staff row, as the payout handlers read it. */
export type StaffOf = (partyId: string) => Promise<{ institutionId: string; role: 'staff' | 'finance' | 'admin' } | undefined>;

/** Org finance of this institution, by its active staff row; any other institution answers 404. */
async function financeOf(req: HttpRequest, staffOf: StaffOf): Promise<{ partyId: string; institutionId: string }> {
  const p = requireRole(req, 'org_finance');
  const staff = await staffOf(p.partyId);
  const institutionId = req.params['id'] ?? '';
  if (!staff || staff.role !== 'finance' || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
  return { partyId: p.partyId, institutionId };
}

export function achPullHandlers(ach: InstitutionAch, stepUp: StepUpService, staffOf: StaffOf): Record<string, Handler> {
  return {
    listInstitutionAchPulls: route(async (req) => {
      const { institutionId } = await financeOf(req, staffOf);
      const page = await ach.list(institutionId);
      return ok({ items: page.items, held: toWire(page.held), available: toWire(page.available) });
    }),
    createInstitutionAchPull: route(async (req) => {
      const by = await financeOf(req, staffOf);
      await ach.gate(); // a feature that is off asks for no passkey
      requireStepUp(stepUp, req);
      const key = requireIdempotencyKey(req);
      return created(await ach.pull(by.institutionId, by, req.body, key, req.now));
    }),
  };
}

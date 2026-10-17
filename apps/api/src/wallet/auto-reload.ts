// Auto-reload (T-0503, REQ-WAL-004): a member sets, per purse, a threshold and a target with a saved
// payment method (the vendor's token, never card data). When the available balance drops below the
// threshold, the worker loads the difference to the target through the ordinary LoadWorkflow, at most
// once per 24 hours whatever the outcome: the attempt is claimed by stamping last_attempt_at before the
// pull, and the load's key derives from that stamp, so a rerun inside the window neither loads twice
// nor retries a failure. Setting the rule needs a fresh step-up: it authorises money to move later.
import { DomainError, fromWire, money, toWire, type Currency, type Money } from '@kesher/domain';
import type { FundingMethod } from '@kesher/ports';
import { uuidv7 } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import { LOAD_METHODS, runLoad, WALLET_FLAG, type LoadRun, type LoadService } from './loads.ts';

export const WINDOW_MS = 24 * 60 * 60_000;

export interface AutoReloadRule {
  id: string;
  partyId: string;
  accountId: string;
  currency: Currency;
  enabled: boolean;
  threshold: Money;
  target: Money;
  method: FundingMethod;
  paymentMethodId: string;
  lastAttemptAt?: string;
  lastTransferId?: string;
  updatedAt: string;
}

/** The OpenAPI `AutoReloadRule`. */
export interface AutoReloadView {
  accountId: string;
  currency: Currency;
  enabled: boolean;
  threshold: ReturnType<typeof toWire>;
  target: ReturnType<typeof toWire>;
  method: FundingMethod;
  paymentMethodId: string;
  lastAttemptAt?: string;
  /** When the next load may happen; absent once the window has passed. */
  nextEligibleAt?: string;
}

export type AttemptOutcome = 'loaded' | 'failed' | 'above_threshold' | 'in_window' | 'disabled';

export interface Attempt {
  rule: AutoReloadRule;
  outcome: AttemptOutcome;
  available: Money;
  /** Set when a load ran: the workflow's result. */
  run?: LoadRun;
}

interface Row {
  id: string;
  party_id: string;
  account_id: string;
  currency: Currency;
  enabled: boolean;
  threshold_minor: string;
  target_minor: string;
  method: FundingMethod;
  payment_method_id: string;
  last_attempt_at: string | Date | null;
  last_transfer_id: string | null;
  updated_at: string | Date;
}

export class AutoReloadService {
  constructor(
    private readonly db: Database,
    private readonly accounts: AccountService,
    private readonly loads: LoadService,
    private readonly flags: FeatureFlags,
  ) {}

  /** GET /accounts/{id}/auto-reload: the member's rule for one of their purses. */
  async get(partyId: string, accountId: string, now: Date): Promise<AutoReloadView> {
    await this.ownWallet(partyId, accountId);
    const rule = await this.byAccount(accountId);
    if (!rule) throw new DomainError('NOT_FOUND', 'No auto-reload rule on this purse');
    return view(rule, now);
  }

  /** POST /accounts/{id}/auto-reload: create or replace the rule. Idempotent by nature (a replace). */
  async set(partyId: string, accountId: string, body: unknown, now: Date): Promise<AutoReloadView> {
    if (!(await this.flags.isOn(WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
    const { currency } = await this.ownWallet(partyId, accountId);
    const b = parse(body, currency);
    const existing = await this.byAccount(accountId);
    const id = existing?.id ?? uuidv7(now);
    await this.db.query(
      `insert into ops.auto_reload (id, party_id, account_id, currency, enabled, threshold_minor, target_minor, method, payment_method_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       on conflict (account_id) do update set enabled = excluded.enabled, threshold_minor = excluded.threshold_minor, target_minor = excluded.target_minor,
         method = excluded.method, payment_method_id = excluded.payment_method_id, updated_at = excluded.updated_at`,
      [id, partyId, accountId, currency, b.enabled, b.threshold.minor.toString(), b.target.minor.toString(), b.method, b.paymentMethodId, now],
    );
    return view((await this.byAccount(accountId))!, now);
  }

  /** Enabled rules whose window has passed, oldest attempt first. The worker evaluates each. */
  async due(now: Date, limit = 500): Promise<AutoReloadRule[]> {
    const r = await this.db.query<Row>(
      `select * from ops.auto_reload where enabled and (last_attempt_at is null or last_attempt_at <= $1) order by last_attempt_at nulls first, id limit $2`,
      [new Date(now.getTime() - WINDOW_MS), limit],
    );
    return r.rows.map(toRule);
  }

  /**
   * One evaluation of a rule: below the threshold, claim the attempt (the 24 h window starts now,
   * whatever follows) and load target − available. A claim that another run already made is respected.
   */
  async attempt(rule: AutoReloadRule, now: Date): Promise<Attempt> {
    const purse = (await this.accounts.purses(rule.partyId)).find((p) => p.currency === rule.currency)!;
    const available = purse.available;
    if (!rule.enabled) return { rule, outcome: 'disabled', available };
    if (rule.lastAttemptAt && Date.parse(rule.lastAttemptAt) > now.getTime() - WINDOW_MS) return { rule, outcome: 'in_window', available };
    if (available.minor >= rule.threshold.minor) return { rule, outcome: 'above_threshold', available };
    const claimed = await this.db.query<Row>(
      `update ops.auto_reload set last_attempt_at = $2, updated_at = $2 where id = $1 and enabled and (last_attempt_at is null or last_attempt_at <= $3) returning *`,
      [rule.id, now, new Date(now.getTime() - WINDOW_MS)],
    );
    if (!claimed.rows[0]) return { rule, outcome: 'in_window', available };
    const current = toRule(claimed.rows[0]);
    const amount = money(rule.target.minor - available.minor, rule.currency);
    const key = `auto-reload:${rule.id}:${Date.parse(current.lastAttemptAt!)}`;
    let run: LoadRun;
    try {
      run = await runLoad(this.loads, { payerPartyId: rule.partyId, memberPartyId: rule.partyId, method: rule.method, amount, paymentMethodId: rule.paymentMethodId }, key, now);
    } catch (e) {
      // An outage or a refused input: the window still stands, so the member is not charged in a loop.
      await this.db.query(`update ops.auto_reload set updated_at = $2 where id = $1`, [rule.id, now]);
      throw e;
    }
    await this.db.query(`update ops.auto_reload set last_transfer_id = $2, updated_at = $3 where id = $1`, [rule.id, run.transfer.id, now]);
    return { rule: { ...current, lastTransferId: run.transfer.id }, outcome: run.transfer.state === 'failed' ? 'failed' : 'loaded', available, run };
  }

  async byAccount(accountId: string): Promise<AutoReloadRule | undefined> {
    const r = await this.db.query<Row>('select * from ops.auto_reload where account_id = $1', [accountId]);
    return r.rows[0] ? toRule(r.rows[0]) : undefined;
  }

  private async ownWallet(partyId: string, accountId: string): Promise<{ currency: Currency }> {
    const purse = (await this.accounts.purses(partyId)).find((p) => p.id === accountId);
    if (!purse) throw new DomainError('NOT_FOUND', 'Purse not found');
    return { currency: purse.currency };
  }
}

function parse(body: unknown, currency: Currency): { enabled: boolean; threshold: Money; target: Money; method: FundingMethod; paymentMethodId: string } {
  const b = (body ?? {}) as { enabled?: unknown; threshold?: unknown; target?: unknown; method?: unknown; paymentMethodId?: unknown };
  const enabled = b.enabled === undefined ? true : b.enabled;
  if (typeof enabled !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'enabled must be a boolean');
  const wire = (v: unknown, name: string): Money => {
    let m: Money;
    try {
      m = fromWire(v as { minor: string; currency: string });
    } catch {
      throw new DomainError('VALIDATION_FAILED', `${name} must be { minor, currency }`);
    }
    if (m.currency !== currency) throw new DomainError('VALIDATION_FAILED', `${name} must be in the purse's currency (${currency})`);
    if (m.minor < 0n) throw new DomainError('VALIDATION_FAILED', `${name} must not be negative`);
    return m;
  };
  const threshold = wire(b.threshold, 'threshold');
  const target = wire(b.target, 'target');
  if (target.minor <= threshold.minor) throw new DomainError('VALIDATION_FAILED', 'target must be above threshold');
  if (typeof b.method !== 'string' || !LOAD_METHODS.includes(b.method as FundingMethod)) throw new DomainError('VALIDATION_FAILED', `method must be one of ${LOAD_METHODS.join(', ')}`);
  if (typeof b.paymentMethodId !== 'string' || !b.paymentMethodId || b.paymentMethodId.length > 128) throw new DomainError('VALIDATION_FAILED', 'paymentMethodId is required (the saved payment method)');
  return { enabled, threshold, target, method: b.method as FundingMethod, paymentMethodId: b.paymentMethodId };
}

export function view(rule: AutoReloadRule, now: Date): AutoReloadView {
  const next = rule.lastAttemptAt ? Date.parse(rule.lastAttemptAt) + WINDOW_MS : undefined;
  return {
    accountId: rule.accountId,
    currency: rule.currency,
    enabled: rule.enabled,
    threshold: toWire(rule.threshold),
    target: toWire(rule.target),
    method: rule.method,
    paymentMethodId: rule.paymentMethodId,
    ...(rule.lastAttemptAt ? { lastAttemptAt: rule.lastAttemptAt } : {}),
    ...(next !== undefined && next > now.getTime() ? { nextEligibleAt: new Date(next).toISOString() } : {}),
  };
}

function toRule(r: Row): AutoReloadRule {
  return {
    id: r.id,
    partyId: r.party_id,
    accountId: r.account_id,
    currency: r.currency,
    enabled: r.enabled,
    threshold: money(BigInt(r.threshold_minor), r.currency),
    target: money(BigInt(r.target_minor), r.currency),
    method: r.method,
    paymentMethodId: r.payment_method_id,
    ...(r.last_attempt_at ? { lastAttemptAt: new Date(r.last_attempt_at).toISOString() } : {}),
    ...(r.last_transfer_id ? { lastTransferId: r.last_transfer_id } : {}),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

// US banking for an institution (T-0650, REQ-INS-022), behind institutions.usBanking. An institution gets a US account at the
// banking provider in one of two ways, fixed once chosen (changing it is an ops action that appends a row):
// - `institution`: its own US entity (any legal form). The provider entity is created once, the hosted application is opened for the
//   requesting admin's IP, and the status follows the bank's decision.
// - `platform`: a sub-account under the platform company's entity, which Kesher ops onboard once (`usBankingPlatformEntityRef`). There
//   is no form; the unit is approved when it exists. If the provider keeps one pooled account, the institution `sharesPlatformAccount`
//   and has no balance or number of its own to show.
//
// Provider ids (the entity or sub-account) live only in ops.external_ref. The status is an insert-only event log: the current status
// is the latest row, and a rejection followed by a new application is a new row. The status follows the provider by the T-0649 webhook
// (`onProviderApplication`, which maps the provider's id back to OUR institution, and ignores one it does not know) and by a poll on GET.
// Money features (collections T-0652, ACH funding T-0653) open only when the provider approved AND the institution's KYB allows
// `us_banking`: `moneyOpen` says so. Names and EINs are not logged; the account is read as its last four digits and a balance.
import { createHash } from 'node:crypto';
import type { KeyLedger } from '@kesher/adapters';
import { DomainError, toWire, uuidv7 } from '@kesher/domain';
import { InstitutionBankingError, type ApplicationStatus, type InstitutionBankingPort, type ProviderRegistry } from '@kesher/ports';
import type { AuditService } from '../audit/service.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database, SqlClient } from '../db.ts';
import { created, ok, requireIdempotencyKey, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
import type { KybGate } from './kyb-gate.ts';

export const US_BANKING_FLAG = 'institutions.usBanking';
const ENTITY_TYPE = 'institution_us_banking';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const EIN = /^\d{2}-?\d{7}$/;
const IP = /^[0-9a-f.:]{3,45}$/i;

export type UsBankingHolder = 'platform' | 'institution';

/** The banking adapter's idempotency ledger (T-0648) in Postgres: a retry after a restart reaches the same object. First write wins. */
export class PostgresKeyLedger implements KeyLedger {
  private readonly db: SqlClient;
  private readonly clock: () => Date;
  constructor(db: SqlClient, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }
  async get(key: string): Promise<{ body: string; result: unknown } | undefined> {
    const r = await this.db.query<{ body_hash: string; result: unknown }>('select body_hash, result from org.us_banking_key where key = $1', [key]);
    const row = r.rows[0];
    return row ? { body: row.body_hash, result: row.result ?? undefined } : undefined;
  }
  async put(key: string, entry: { body: string; result: unknown }): Promise<void> {
    await this.db.query('insert into org.us_banking_key (key, body_hash, result, created_at) values ($1, $2, $3, $4) on conflict (key) do nothing', [key, entry.body, JSON.stringify(entry.result ?? null), this.clock()]);
  }
}

export interface UsBankingDeps {
  db: Database;
  flags: FeatureFlags;
  audit: AuditService;
  kyb: KybGate;
  registry: ProviderRegistry;
  /** The platform company's provider entity (approved by ops), for institutions that bank under it. */
  platformEntityRef: () => string | undefined;
}

interface Latest {
  holder: UsBankingHolder;
  status: ApplicationStatus;
  sharesPlatformAccount: boolean;
}

export interface UsBankingLink {
  status: ApplicationStatus;
  holder: UsBankingHolder;
  sharesPlatformAccount: boolean;
  /** The hosted application, for an institution's own entity that still has to apply. */
  formUrl?: string;
}

export interface UsBankingView {
  status: ApplicationStatus | 'not_linked';
  holder?: UsBankingHolder;
  sharesPlatformAccount?: boolean;
  /** Provider approved and the institution's KYB allows it: collections and funding may open. */
  moneyOpen: boolean;
  last4?: string;
  balance?: { minor: string; currency: string };
}

/** A port failure as the API's closed error set. */
function asDomain(e: unknown): never {
  if (!(e instanceof InstitutionBankingError)) throw e;
  if (e.code === 'VALIDATION_FAILED' || e.code === 'NOT_APPROVED') throw new DomainError('VALIDATION_FAILED', e.code === 'NOT_APPROVED' ? 'The banking account is not ready yet' : e.message);
  if (e.code === 'IDEMPOTENCY_CONFLICT') throw new DomainError('IDEMPOTENCY_CONFLICT', 'That key was used for a different request');
  throw new DomainError('PROVIDER_UNAVAILABLE', 'The banking provider is not available');
}

export class InstitutionUsBanking {
  private readonly d: UsBankingDeps;
  constructor(deps: UsBankingDeps) {
    this.d = deps;
  }

  async requireFlag(): Promise<void> {
    if (!(await this.d.flags.isOn(US_BANKING_FLAG))) throw new DomainError('FEATURE_OFF', 'US banking is not available');
  }

  /**
   * Links (or resumes) the institution's US account. The same key and body answer the same result; nothing is created twice. It all runs
   * in one transaction under a lock on the institution's row, so two requests for one institution (the same key twice, or two keys, or two
   * holders) take turns. The provider is called inside it: an admin action, rare, and a rollback leaves nothing half-linked here (the
   * provider's own idempotency, and the adapter's ledger, take it from there on a retry).
   */
  async link(institutionId: string, actorId: string, rawBody: unknown, key: string, ip: string | undefined, now: Date): Promise<UsBankingLink> {
    await this.requireFlag();
    const body = parseLink(rawBody);
    const hash = sha256(JSON.stringify(body));
    const ledgerKey = `link:${institutionId}:${key}`;
    const link = await this.d.db.transaction(async (tx) => {
      const inst = (await tx.query<{ market: 'IL' | 'US' }>('select market from org.institution where id = $1 for update', [institutionId])).rows[0];
      if (!inst) throw new DomainError('NOT_FOUND', 'Institution not found');
      const port = this.d.registry.resolve<InstitutionBankingPort>('institution-banking', inst.market);
      const provider = this.d.registry.bindingFor('institution-banking', inst.market)?.provider ?? 'simulator';
      const cur = await this.latest(institutionId, tx);
      const prior = (await tx.query<{ body_hash: string; result: UsBankingLink }>('select body_hash, result from org.us_banking_key where key = $1', [ledgerKey])).rows[0];
      if (prior) {
        if (prior.body_hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'That key was used for a different request');
        // A replay answers the stored result. The hosted form's link is not kept (it is the applicant's to use): the bank is asked for it again.
        const ref = await this.refOf(institutionId, tx);
        const open = cur?.holder === 'institution' && (cur.status === 'pending' || cur.status === 'needs_info');
        const form = open && ref && ip ? await port.startApplication({ entityRef: ref.externalId, applicantIp: ip }).catch(asDomain) : undefined;
        return { ...prior.result, ...(cur ? { status: cur.status } : {}), ...(form ? { formUrl: form.formUrl } : {}) };
      }
      if (cur && cur.holder !== body.holder) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This institution is linked the other way; changing it is an ops action');
      // The provider hears our key scoped to the institution: two institutions sending the same key share nothing.
      const scoped = `${institutionId}:${key}`;
      const out = body.holder === 'platform' ? await this.linkPlatform(tx, institutionId, scoped, cur, port, provider, now) : await this.linkOwn(tx, institutionId, scoped, body.usEntity, inst.market, cur, ip, port, provider, now);
      await tx.query('insert into org.us_banking_key (key, body_hash, result, created_at) values ($1, $2, $3, $4) on conflict (key) do nothing', [ledgerKey, hash, JSON.stringify({ status: out.status, holder: out.holder, sharesPlatformAccount: out.sharesPlatformAccount }), now]);
      return out;
    });
    await this.d.audit.record({ actorId, actorRole: 'org_admin', action: 'institution.us_banking.link', subject: institutionId, reason: `US banking: ${body.holder}`, payload: { institutionId, holder: body.holder, status: link.status } }, now);
    return link;
  }

  private async linkPlatform(tx: SqlClient, institutionId: string, key: string, cur: Latest | undefined, port: InstitutionBankingPort, provider: string, now: Date): Promise<UsBankingLink> {
    if (cur && (await this.refOf(institutionId, tx))) return { status: cur.status, holder: 'platform', sharesPlatformAccount: cur.sharesPlatformAccount };
    const platformRef = this.d.platformEntityRef();
    if (!platformRef) throw new DomainError('VALIDATION_FAILED', 'The platform banking account is not set up yet');
    const sub = await port.createSubAccount({ entityRef: platformRef, institutionId, idempotencyKey: key }).catch(asDomain);
    await this.claimRef(tx, institutionId, provider, sub.subAccountRef);
    const shares = !sub.hasOwnAccountNumber;
    await this.appendIfChanged(tx, institutionId, 'platform', 'approved', 'sub_account', shares, key, now);
    return { status: 'approved', holder: 'platform', sharesPlatformAccount: shares };
  }

  private async linkOwn(tx: SqlClient, institutionId: string, key: string, usEntity: { legalName: string; ein: string } | undefined, market: 'IL' | 'US', cur: Latest | undefined, ip: string | undefined, port: InstitutionBankingPort, provider: string, now: Date): Promise<UsBankingLink> {
    if (cur?.status === 'approved') return { status: 'approved', holder: 'institution', sharesPlatformAccount: false };
    if (!ip) throw new DomainError('VALIDATION_FAILED', 'The requester\'s IP address is needed to open the application form');
    const existing = await this.refOf(institutionId, tx);
    let entityRef = existing?.externalId;
    if (!entityRef) {
      const entity = usEntity ?? (market === 'US' ? await this.applicationEntity(institutionId, tx) : undefined);
      if (!entity) throw new DomainError('VALIDATION_FAILED', 'A US entity (legal name and EIN) is needed');
      entityRef = (await port.createEntity({ holder: 'institution', institutionId, legalName: entity.legalName, ein: entity.ein, idempotencyKey: key }).catch(asDomain)).entityRef;
      // Before the hosted form: the provider may hand back an entity another institution already holds (it matches by name).
      await this.claimRef(tx, institutionId, provider, entityRef);
    }
    const form = await port.startApplication({ entityRef, applicantIp: ip }).catch(asDomain);
    const fresh = !cur || cur.status === 'rejected';
    if (fresh) await this.appendIfChanged(tx, institutionId, 'institution', 'pending', null, false, key, now);
    return { status: fresh ? 'pending' : cur.status, holder: 'institution', sharesPlatformAccount: false, formUrl: form.formUrl };
  }

  /** The status, polled from the provider while the application is open; the account, once approved. */
  async read(institutionId: string, now: Date): Promise<UsBankingView> {
    await this.requireFlag();
    const cur = await this.latest(institutionId);
    if (!cur) return { status: 'not_linked', moneyOpen: false };
    const ref = await this.refOf(institutionId);
    const inst = (await this.d.db.query<{ market: 'IL' | 'US' }>('select market from org.institution where id = $1', [institutionId])).rows[0];
    if (!ref || !inst) return { status: cur.status, holder: cur.holder, sharesPlatformAccount: cur.sharesPlatformAccount, moneyOpen: false };
    const port = this.d.registry.resolve<InstitutionBankingPort>('institution-banking', inst.market);
    let status = cur.status;
    if (cur.holder === 'institution' && (status === 'pending' || status === 'needs_info')) {
      try {
        const polled = await port.applicationStatus(ref.externalId);
        if (polled !== status) {
          // GET records the provider's word, never user input; it takes the institution's lock so a poll and an event do not both append.
          status = (await this.record(institutionId, 'institution', polled, polled, now)) ?? polled;
        }
      } catch {
        // The provider is unavailable: the last known status stands.
      }
    }
    const view: UsBankingView = { status, holder: cur.holder, sharesPlatformAccount: cur.sharesPlatformAccount, moneyOpen: status === 'approved' && (await this.d.kyb.allows(institutionId, 'us_banking')) };
    if (status === 'approved' && !cur.sharesPlatformAccount) {
      try {
        const a = await port.account(ref.externalId);
        view.last4 = a.last4;
        view.balance = toWire(a.balance);
      } catch {
        // No balance this time; the status is still true.
      }
    }
    return view;
  }

  /**
   * The provider's own word on an application (a T-0649 event, re-read through the port): the provider's id is mapped back to OUR
   * institution here, and one we do not know is ignored. Only an institution's own application has a status to follow.
   */
  async onProviderApplication(entityRef: string, status: ApplicationStatus, now: Date): Promise<void> {
    const r = await this.d.db.query<{ entity_id: string }>('select entity_id from ops.external_ref where entity_type = $1 and external_id = $2', [ENTITY_TYPE, entityRef]);
    const institutionId = r.rows[0]?.entity_id;
    if (institutionId) await this.record(institutionId, 'institution', status, status, now);
  }

  /** The institution's US account as other cards (US funding, fees) need it: who holds it, its status, the provider's id for it, and its market. */
  async account(institutionId: string, client: SqlClient = this.d.db): Promise<{ holder: UsBankingHolder; status: ApplicationStatus; sharesPlatformAccount: boolean; ref?: string; provider?: string; market: 'IL' | 'US' } | undefined> {
    const cur = await this.latest(institutionId, client);
    if (!cur) return undefined;
    const ref = await this.refOf(institutionId, client);
    const inst = (await client.query<{ market: 'IL' | 'US' }>('select market from org.institution where id = $1', [institutionId])).rows[0];
    return inst ? { ...cur, market: inst.market, ...(ref ? { ref: ref.externalId, provider: ref.provider } : {}) } : undefined;
  }

  /** Appends the provider's status if it differs from the latest, under the institution's lock. Answers the status now current. */
  private async record(institutionId: string, holder: UsBankingHolder, status: ApplicationStatus, providerStatus: string, now: Date): Promise<ApplicationStatus | undefined> {
    return this.d.db.transaction(async (tx) => {
      await tx.query('select 1 from org.institution where id = $1 for update', [institutionId]);
      const cur = await this.latest(institutionId, tx);
      if (!cur || cur.holder !== 'institution' || holder !== 'institution') return cur?.status;
      await this.appendIfChanged(tx, institutionId, holder, status, providerStatus, false, null, now);
      return status;
    });
  }

  private async latest(institutionId: string, client: SqlClient = this.d.db): Promise<Latest | undefined> {
    const r = await client.query<{ holder: UsBankingHolder; status: ApplicationStatus; shares_platform_account: boolean }>(
      'select holder, status, shares_platform_account from org.institution_us_banking_event where institution_id = $1 order by seq desc limit 1',
      [institutionId],
    );
    const row = r.rows[0];
    return row ? { holder: row.holder, status: row.status, sharesPlatformAccount: row.shares_platform_account } : undefined;
  }

  private async refOf(institutionId: string, client: SqlClient = this.d.db): Promise<{ provider: string; externalId: string } | undefined> {
    const r = await client.query<{ provider: string; external_id: string }>('select provider, external_id from ops.external_ref where entity_type = $1 and entity_id = $2', [ENTITY_TYPE, institutionId]);
    return r.rows[0] ? { provider: r.rows[0].provider, externalId: r.rows[0].external_id } : undefined;
  }

  /**
   * Maps the provider's id to this institution. If the id is already another institution's, the provider handed back an account that is not
   * this institution's to use (it matches organizations by name): nothing is written and the request is refused.
   */
  private async claimRef(tx: SqlClient, institutionId: string, provider: string, externalId: string): Promise<void> {
    await tx.query('insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing', [ENTITY_TYPE, institutionId, provider, externalId]);
    const owner = (await tx.query<{ entity_id: string; entity_type: string }>('select entity_id, entity_type from ops.external_ref where provider = $1 and external_id = $2', [provider, externalId])).rows[0];
    if (!owner || owner.entity_type !== ENTITY_TYPE || owner.entity_id !== institutionId) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'That US entity is already banked by another institution');
    }
  }

  /** Appends a status row unless the latest already says it: a repeated event, a second poll, or a racing request adds nothing. */
  private async appendIfChanged(tx: SqlClient, institutionId: string, holder: UsBankingHolder, status: ApplicationStatus, providerStatus: string | null, shares: boolean, key: string | null, now: Date): Promise<void> {
    await tx.query(
      `insert into org.institution_us_banking_event (id, institution_id, holder, status, provider_status, shares_platform_account, idempotency_key, at)
       select $1, $2, $3, $4, $5, $6, $7, $8
       where (select status from org.institution_us_banking_event where institution_id = $2 order by seq desc limit 1) is distinct from $4`,
      [uuidv7(now), institutionId, holder, status, providerStatus, shares, key, now],
    );
  }

  /** A US institution's entity as it applied: its legal name and EIN. */
  private async applicationEntity(institutionId: string, client: SqlClient): Promise<{ legalName: string; ein: string } | undefined> {
    const r = await client.query<{ legal_name: string; registration_number: string }>('select legal_name, registration_number from org.institution_application where institution_id = $1', [institutionId]);
    const a = r.rows[0];
    return a && EIN.test(a.registration_number) ? { legalName: a.legal_name, ein: normaliseEin(a.registration_number) } : undefined;
  }
}

const normaliseEin = (ein: string): string => {
  const digits = ein.replace('-', '');
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
};

function parseLink(raw: unknown): { holder: UsBankingHolder; usEntity?: { legalName: string; ein: string } } {
  const b = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (b['holder'] !== 'platform' && b['holder'] !== 'institution') throw new DomainError('VALIDATION_FAILED', 'holder must be platform or institution');
  const e = b['usEntity'];
  if (e === undefined) return { holder: b['holder'] };
  const u = typeof e === 'object' && e !== null && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
  const legalName = typeof u['legalName'] === 'string' ? u['legalName'].trim() : '';
  if (!legalName || legalName.length > 200 || typeof u['ein'] !== 'string' || !EIN.test(u['ein'])) throw new DomainError('VALIDATION_FAILED', 'usEntity needs a legal name and an EIN (NN-NNNNNNN)');
  return { holder: b['holder'], usEntity: { legalName, ein: normaliseEin(u['ein']) } };
}

type StaffOfFn = (partyId: string) => Promise<{ institutionId: string; role: 'staff' | 'finance' | 'admin' } | undefined>;

/**
 * The requester's address: the last entry the load balancer appended to X-Forwarded-For (an earlier one is the client's to forge). The API sits
 * behind exactly one internet-facing ALB; if a CDN is ever put in front of it, the client is the entry before the last.
 */
function clientIp(req: HttpRequest): string | undefined {
  const last = (req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
  return last && IP.test(last) ? last : undefined;
}

export function usBankingHandlers(svc: InstitutionUsBanking, stepUp: StepUpService, staffOf: StaffOfFn): Record<string, Handler> {
  /** Active staff of this institution with one of the roles. Another institution reads as not found. */
  const own = async (req: HttpRequest, roles: readonly ('admin' | 'finance')[]) => {
    const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    const staff = await staffOf(p.partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    if (!(roles as readonly string[]).includes(staff.role)) throw new DomainError('FORBIDDEN', roles.length === 1 ? 'Only institution admins link the US account' : 'Only finance staff and admins read the US account');
    return { institutionId, partyId: p.partyId };
  };
  return {
    createInstitutionUsBanking: route(async (req) => {
      await svc.requireFlag();
      const { institutionId, partyId } = await own(req, ['admin']);
      requireStepUp(stepUp, req);
      return created(await svc.link(institutionId, partyId, req.body, requireIdempotencyKey(req), clientIp(req), req.now));
    }),
    getInstitutionUsBanking: route(async (req) => {
      await svc.requireFlag();
      const { institutionId } = await own(req, ['admin', 'finance']);
      return ok(await svc.read(institutionId, req.now));
    }),
  };
}

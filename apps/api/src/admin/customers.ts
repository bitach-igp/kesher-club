// Customer search and the Customer 360 read model (T-0907, ADR-013). The console never reads the
// database; it reads this. Identity lives in the identity repository, everything else in Postgres.
// The model carries no PAN and no full phone: the phone leaves this module as its last four digits.
// Reads only; nothing here provisions accounts or writes a row.
import { createHash } from 'node:crypto';
import { toWire, type Currency } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { IdentityRepository, UserAccount } from '../auth/repository.ts';
import type { Database } from '../db.ts';
import type { PostgresLedger } from '../ledger/post.ts';

export interface CustomerSummary {
  partyId: string;
  /** org.member name when the roster knows the person; otherwise "Member •••• 4567". */
  displayName: string;
  /** Last four digits only. */
  phoneMasked: string;
  status: UserAccount['status'];
  /** Locale of the most recent consent; 'en' before any consent. */
  locale: 'en' | 'he';
  mode: 'member' | 'funder' | 'both';
  createdAt: string;
}

export interface Customer360 extends CustomerSummary {
  restrictedUntil?: string;
  /** No KYC decision is stored before the card programme (E04); until then every customer is 'none'. */
  kyc: { status: 'none' | 'pending' | 'verified' | 'rejected'; provider?: string; checkedAt?: string };
  memberships: { id: string; planCode: string; status: 'incomplete' | 'active' | 'past_due' | 'paused' | 'cancelled'; role: 'member' | 'funder'; counterpartyId: string; institutionName?: string; currentPeriodEnd?: string }[];
  purses: { id: string; currency: Currency; available: { minor: string; currency: Currency }; holds: { minor: string; currency: Currency } }[];
  /** Empty until the card programme lands (E04). Never more than the last four digits. */
  cards: { id: string; last4: string; type: 'virtual' | 'physical'; status: 'inactive' | 'active' | 'frozen' | 'closed'; tokens: number }[];
  openCases: { id: string; kind: string; severity: 'low' | 'medium' | 'high' | 'critical'; status: 'open' | 'investigating'; openedAt: string }[];
  consents: { document: string; version: number; hash: string; acceptedAt: string }[];
  grants: { id: string; clientName: string; clientId: string; scopes: string[]; createdAt: string; lastUsedAt?: string; revokedAt?: string }[];
  audit: { at: string; actorId: string; actorRole: string; action: string; reason: string }[];
}

export interface CustomerReadModelDeps {
  db: Database;
  identity: IdentityRepository;
  ledger: PostgresLedger;
  audit: AuditService;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{5,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEARCH_LIMIT = 20;
const AUDIT_TAIL = 20;

/** +972501234567 → "•••• 4567". Country codes narrow a person down too, so only the tail survives. */
export const maskPhone = (e164: string): string => `•••• ${e164.slice(-4)}`;

/** The same hash org.invite stores for a recipient address (institutions/invites.ts). */
const recipientHash = (email: string): string => createHash('sha256').update(email.toLowerCase()).digest('base64url');

/** Escapes LIKE metacharacters so a query of "%" does not match everyone. */
const likeContains = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const iso = (v: string | Date): string => new Date(v).toISOString();

export class CustomerReadModel {
  private readonly d: CustomerReadModelDeps;
  constructor(d: CustomerReadModelDeps) {
    this.d = d;
  }

  /**
   * Phone (E.164, exact), party id (exact), email (exact, via the roster invite hash) or roster name
   * (contains, case-insensitive). The operator must know the full number to find someone by it;
   * results carry only the masked tail.
   */
  async search(query: string): Promise<CustomerSummary[]> {
    const q = query.trim();
    if (!q) return [];
    const users = await this.candidates(q);
    return Promise.all(users.map((u) => this.summary(u)));
  }

  async get(partyId: string): Promise<Customer360 | undefined> {
    const user = await this.d.identity.findUser(partyId);
    if (!user) return undefined;
    const [summary, restriction, memberships, purses, openCases, consents, grants, audit] = await Promise.all([
      this.summary(user),
      this.d.identity.getRestriction(partyId),
      this.memberships(partyId),
      this.purses(partyId),
      this.openCases(partyId),
      this.consents(partyId),
      this.grants(partyId),
      this.d.audit.list(partyId, AUDIT_TAIL),
    ]);
    return {
      ...summary,
      ...(restriction ? { restrictedUntil: restriction.until } : {}),
      kyc: { status: 'none' },
      memberships,
      purses,
      cards: [],
      openCases,
      consents,
      grants,
      audit: audit.map((e) => ({ at: e.at, actorId: e.actorId, actorRole: e.actorRole, action: e.action, reason: e.reason })),
    };
  }

  private async candidates(q: string): Promise<UserAccount[]> {
    if (E164.test(q)) return compact([await this.d.identity.findUserByPhone(q)]);
    if (UUID.test(q)) return compact([await this.d.identity.findUser(q.toLowerCase())]);
    const ids = EMAIL.test(q)
      ? await this.d.db.query<{ member_party_id: string }>(
          `select distinct m.member_party_id from org.invite i join org.member m on m.id = i.member_id where i.recipient_hash = $1 and m.member_party_id is not null limit $2`,
          [recipientHash(q), SEARCH_LIMIT],
        )
      : await this.d.db.query<{ member_party_id: string }>(
          `select distinct member_party_id from org.member where member_party_id is not null and member_name ilike $1 escape '\\' limit $2`,
          [likeContains(q), SEARCH_LIMIT],
        );
    return compact(await Promise.all(ids.rows.map((r) => this.d.identity.findUser(r.member_party_id))));
  }

  private async summary(u: UserAccount): Promise<CustomerSummary> {
    const [name, locale, roles] = await Promise.all([
      this.d.db.query<{ member_name: string }>(`select member_name from org.member where member_party_id = $1 order by updated_at desc limit 1`, [u.partyId]),
      this.d.db.query<{ locale: 'en' | 'he' }>(`select locale from legal.consent where party_id = $1 order by accepted_at desc limit 1`, [u.partyId]),
      this.d.db.query<{ as_member: boolean; as_funder: boolean }>(
        `select exists(select 1 from billing.membership where member_party_id = $1) as as_member, exists(select 1 from billing.membership where funder_party_id = $1) as as_funder`,
        [u.partyId],
      ),
    ]);
    const r = roles.rows[0];
    const mode = r?.as_member && r.as_funder ? 'both' : r?.as_funder ? 'funder' : 'member';
    const phoneMasked = maskPhone(u.phone);
    return { partyId: u.partyId, displayName: name.rows[0]?.member_name ?? `Member ${phoneMasked}`, phoneMasked, status: u.status, locale: locale.rows[0]?.locale ?? 'en', mode, createdAt: u.createdAt };
  }

  private async memberships(partyId: string): Promise<Customer360['memberships']> {
    const r = await this.d.db.query<{ id: string; plan_code: string; status: Customer360['memberships'][number]['status']; member_party_id: string; funder_party_id: string; current_period_end: string | Date | null; institution_name: string | null }>(
      `select m.id, m.plan_code, m.status, m.member_party_id, m.funder_party_id, m.current_period_end,
              (select i.name from org.member om join org.institution i on i.id = om.institution_id where om.member_party_id = m.member_party_id order by om.updated_at desc limit 1) as institution_name
         from billing.membership m where m.member_party_id = $1 or m.funder_party_id = $1 order by m.created_at desc`,
      [partyId],
    );
    return r.rows.map((m) => ({
      id: m.id,
      planCode: m.plan_code,
      status: m.status,
      role: m.member_party_id === partyId ? 'member' : 'funder',
      counterpartyId: m.member_party_id === partyId ? m.funder_party_id : m.member_party_id,
      ...(m.institution_name ? { institutionName: m.institution_name } : {}),
      ...(m.current_period_end ? { currentPeriodEnd: iso(m.current_period_end) } : {}),
    }));
  }

  /** Existing wallet and pending accounts only; a 360 read never provisions a purse. */
  private async purses(partyId: string): Promise<Customer360['purses']> {
    const r = await this.d.db.query<{ id: string; type: 'wallet' | 'pending'; currency: Currency }>(`select id, type, currency from ledger.account where owner_party_id = $1 and type in ('wallet', 'pending') order by currency::text, type`, [partyId]);
    const out: Customer360['purses'] = [];
    for (const wallet of r.rows.filter((a) => a.type === 'wallet')) {
      const pending = r.rows.find((a) => a.type === 'pending' && a.currency === wallet.currency);
      // Credit-normal: negate ledger balances to show what the member owns.
      const available = -(await this.d.ledger.balance(wallet.id, wallet.currency));
      const holds = pending ? -(await this.d.ledger.balance(pending.id, pending.currency)) : 0n;
      out.push({ id: wallet.id, currency: wallet.currency, available: toWire({ minor: available, currency: wallet.currency }), holds: toWire({ minor: holds, currency: wallet.currency }) });
    }
    return out;
  }

  /** Cases whose payload names one of the party's ledger accounts (balance breaks, suspense). */
  private async openCases(partyId: string): Promise<Customer360['openCases']> {
    const r = await this.d.db.query<{ id: string; kind: string; severity: Customer360['openCases'][number]['severity']; status: 'open' | 'investigating'; opened_at: string | Date }>(
      `select c.id, c.kind, c.severity, c.status, c.opened_at from ops.case c join ledger.account a on a.id::text = c.payload->>'accountId'
        where a.owner_party_id = $1 and c.status in ('open', 'investigating') order by c.opened_at desc`,
      [partyId],
    );
    return r.rows.map((c) => ({ id: c.id, kind: c.kind, severity: c.severity, status: c.status, openedAt: iso(c.opened_at) }));
  }

  private async consents(partyId: string): Promise<Customer360['consents']> {
    const r = await this.d.db.query<{ doc_key: string; version: number; hash: string; accepted_at: string | Date }>(`select doc_key, version, hash, accepted_at from legal.consent where party_id = $1 order by accepted_at desc`, [partyId]);
    return r.rows.map((c) => ({ document: c.doc_key, version: Number(c.version), hash: c.hash, acceptedAt: iso(c.accepted_at) }));
  }

  private async grants(partyId: string): Promise<Customer360['grants']> {
    const r = await this.d.db.query<{ id: string; client_id: string; name: string; scopes: string[]; created_at: string | Date; last_used_at: string | Date | null; revoked_at: string | Date | null }>(
      `select g.id, g.client_id, c.name, g.scopes, g.created_at, g.last_used_at, g.revoked_at from agent.grant g join agent.client c on c.client_id = g.client_id where g.party_id = $1 order by (g.status = 'active') desc, g.created_at desc`,
      [partyId],
    );
    return r.rows.map((g) => ({ id: g.id, clientName: g.name, clientId: g.client_id, scopes: g.scopes, createdAt: iso(g.created_at), ...(g.last_used_at ? { lastUsedAt: iso(g.last_used_at) } : {}), ...(g.revoked_at ? { revokedAt: iso(g.revoked_at) } : {}) }));
  }
}

const compact = <T>(xs: readonly (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined);

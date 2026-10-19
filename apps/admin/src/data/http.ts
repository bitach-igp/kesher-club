// AdminData over the API (T-0906, T-0907, T-0908, ADR-013): the console's server side calls
// /admin/* through the typed SDK with a fresh staff token per call. The API stamps actors from the
// token and timestamps from its own clock, so the `by` and `now` the screens pass stay local.
// One API runs per market on one shared database (T-0026, T-0913): club-wide data comes from the
// HOME_MARKET API, provider bindings from each market's own, and `apiFor(market)` is the route a
// provider-calling staff action takes to the member's market.
import { fromWire } from '@kesher/domain';
import { ApiError, createClient, type Client, type Schemas } from '@kesher/sdk';
import type { StaffSigner } from '../auth/staff-token.ts';
import type { Market } from '@kesher/ports';
import { gatesFor } from '../providers/release-gates.ts';
import { AdminDataError, type AdminActor, type AdminData, type Alert, type Complaint, type CustomerRecord, type CustomerSummary, type FlagState, type ProviderBinding } from './types.ts';

export const MARKETS: readonly Market[] = ['IL', 'US'];
/** Club-wide reads and writes go here; any market's API serves them from the shared database, so the choice is fixed. */
export const HOME_MARKET: Market = 'IL';

export interface HttpAdminDataOptions {
  /** Each market's API base URL, with its `/v1` prefix. */
  apis: Readonly<Record<Market, string>>;
  signer: StaffSigner;
  /** Who is acting on this request (from the proxy's headers). */
  actor: () => Promise<AdminActor>;
  fetch?: typeof fetch | undefined;
}

const notYet = (what: string): never => {
  throw new AdminDataError('UNAVAILABLE', `${what} arrives with the next admin API card`);
};

export const flagState = (f: Schemas['AdminFlag']): FlagState => ({
  key: f.key,
  on: f.value,
  // Gate ticks are not stored server-side yet; a live flag is shown fully gated, an off flag unticked.
  gatesTicked: f.value ? gatesFor(f.key).map((g) => g.id) : [],
  ...(f.pendingFlip ? { pendingFlip: { requestId: f.pendingFlip.id, to: (f.pendingFlip.payload as { to?: boolean }).to === true, requestedBy: f.pendingFlip.requestedBy, approvals: [f.pendingFlip.requestedBy], requestedAt: f.pendingFlip.expiresAt } } : {}),
  ...(f.changedAt ? { lastChangedAt: f.changedAt } : {}),
});

/** The API already masks the phone; the console keeps the masked form and has no email to show. */
export const customerSummary = (c: Schemas['AdminCustomerSummary']): CustomerSummary => ({ partyId: c.partyId, displayName: c.displayName, phone: c.phoneMasked, locale: c.locale, mode: c.mode, createdAt: c.createdAt });

export const customerRecord = (c: Schemas['AdminCustomer']): CustomerRecord => ({
  ...customerSummary(c),
  kyc: { status: c.kyc.status, provider: c.kyc.provider, checkedAt: c.kyc.checkedAt },
  // The API names the other party by id; the console shows the institution and leaves the funder's name to the roster.
  memberships: c.memberships.map((m) => ({ id: m.id, planCode: m.planCode, status: m.status, institutionName: m.institutionName, currentPeriodEnd: m.currentPeriodEnd })),
  accounts: c.purses.map((p) => ({ id: p.id, currency: p.currency, available: fromWire(p.available), holds: fromWire(p.holds) })),
  cards: c.cards.map((k) => ({ id: k.id, last4: k.last4, type: k.type, status: k.status, tokens: k.tokens })),
  cases: c.openCases.map((k) => ({ id: k.id, kind: k.kind, severity: k.severity, status: k.status, openedAt: k.openedAt })),
  consents: c.consents.map((x) => ({ document: x.document, version: String(x.version), acceptedAt: x.acceptedAt })),
  grants: c.grants.map((g) => ({ id: g.id, clientName: g.clientName, scopes: [...g.scopes], lastUsedAt: g.lastUsedAt, revokedAt: g.revokedAt })),
  audit: c.audit.map((e) => ({ at: e.at, actor: e.actorId, action: e.action, detail: e.reason })),
  restrictedUntil: c.restrictedUntil,
});

export const complaint = (c: Schemas['AdminComplaint']): Complaint => ({
  id: c.id,
  partyId: c.partyId,
  channel: c.channel,
  category: c.category,
  summary: c.summary,
  openedAt: c.openedAt,
  acknowledgedAt: c.acknowledgedAt,
  resolvedAt: c.resolvedAt,
  status: c.status,
  owner: c.owner,
  escalatedToBank: c.escalatedToBank,
});

export const alert = (a: Schemas['AdminAlert']): Alert => ({
  id: a.id,
  kind: a.kind,
  severity: a.severity,
  status: a.status,
  partyId: a.partyId,
  summary: a.summary,
  openedAt: a.openedAt,
  decidedBy: a.decidedBy,
  decidedAt: a.decidedAt,
  note: a.note,
});

const mapError = (e: unknown): never => {
  if (e instanceof ApiError) {
    const code = e.problem.code;
    if (code === 'NOT_FOUND') throw new AdminDataError('NOT_FOUND', e.message);
    if (code === 'IDEMPOTENCY_CONFLICT') throw new AdminDataError('CONFLICT', e.message);
    if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') throw new AdminDataError('FORBIDDEN', e.message);
    throw new AdminDataError('CONFLICT', e.message);
  }
  throw e;
};

export function httpAdminData(o: HttpAdminDataOptions): AdminData & { apiFor(market: Market): Client } {
  const clientFor = (baseUrl: string): Client =>
    createClient({
      baseUrl,
      ...(o.fetch ? { fetch: o.fetch } : {}),
      getAccessToken: async () => o.signer.sign(await o.actor()),
    });
  const clients: Readonly<Record<Market, Client>> = { IL: clientFor(o.apis.IL), US: clientFor(o.apis.US) };
  const client = clients[HOME_MARKET];
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      return mapError(e);
    }
  };

  const data: AdminData = {
    async searchCustomers(query) {
      const q = query.trim();
      if (!q) return [];
      const r = await run(() => client.get('/admin/customers', { query: { q } }));
      return r.items.map(customerSummary);
    },
    async getCustomer(partyId) {
      try {
        return customerRecord(await run(() => client.get('/admin/customers/{id}', { path: { id: partyId } })));
      } catch (e) {
        if (e instanceof AdminDataError && e.code === 'NOT_FOUND') return undefined;
        throw e;
      }
    },
    async listAlerts() {
      return (await run(() => client.get('/admin/alerts'))).items.map(alert);
    },
    async decideAlert(id, decision, _by, note) {
      return alert(await run(() => client.post('/admin/alerts/{id}/decisions', { path: { id }, body: { decision, note } })));
    },
    async listComplaints() {
      return (await run(() => client.get('/admin/complaints'))).items.map(complaint);
    },
    async acknowledgeComplaint(id) {
      return complaint(await run(() => client.post('/admin/complaints/{id}/acknowledge', { path: { id } })));
    },
    async resolveComplaint(id) {
      return complaint(await run(() => client.post('/admin/complaints/{id}/resolve', { path: { id } })));
    },

    async listBindings(): Promise<ProviderBinding[]> {
      // Each market's API reports its own bindings, labelled with the market it serves.
      const perMarket = await Promise.all(MARKETS.map((m) => run(() => clients[m].get('/admin/bindings'))));
      return perMarket.flatMap((r) => r.items.map((b) => ({ capability: b.capability, market: b.market, binding: !b.provider || b.provider === 'simulator' ? 'simulator' : b.provider, degraded: false, contractGreenNights: 0 })));
    },
    async listFlags(): Promise<FlagState[]> {
      const r = await run(() => client.get('/admin/flags'));
      return r.items.map(flagState);
    },
    async getFlag(key) {
      return (await data.listFlags()).find((f) => f.key === key);
    },
    async tickGate() {
      return notYet('Gate ticks');
    },
    async proposeFlip(key, to) {
      await run(() => client.post('/admin/flags/{key}/flips', { path: { key }, body: { to, reason: 'Proposed from the admin console' } }));
      const f = await data.getFlag(key);
      if (!f) throw new AdminDataError('NOT_FOUND', `Unknown flag ${key}`);
      return f;
    },
    async approveFlip(key) {
      const f = await data.getFlag(key);
      if (!f?.pendingFlip) throw new AdminDataError('NOT_FOUND', 'No pending flip');
      await run(() => client.post('/admin/flag-flips/{id}/approve', { path: { id: f.pendingFlip!.requestId } }));
      return (await data.getFlag(key))!;
    },
    async killSwitch(key, by, now) {
      // The API's kill path is the same two-person flip to false (REQ-ADM-002); one admin proposes.
      return data.proposeFlip(key, false, by, now);
    },
    async auditLog() {
      // The API audits per subject; the console's log is the union over the flags that changed.
      const flags = await data.listFlags();
      const out: { at: string; actor: string; action: string; subject: string; detail?: string | undefined }[] = [];
      for (const f of flags) {
        if (!f.lastChangedAt) continue;
        const r = await run(() => client.get('/admin/audit', { query: { subject: f.key, limit: 20 } }));
        for (const e of r.items) out.push({ at: e.at, actor: e.actorId, action: e.action, subject: e.subject, detail: e.reason });
      }
      return out.sort((a, b) => b.at.localeCompare(a.at));
    },
  };
  return { ...data, apiFor: (market) => clients[market] };
}

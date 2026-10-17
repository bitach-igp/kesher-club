// AdminData over the API (T-0906, ADR-013): the console's server side calls /admin/* through the
// typed SDK with a fresh staff token per call. Flags, bindings and audit land here; customers,
// alerts and complaints follow with T-0907 and T-0908 and answer UNAVAILABLE until then.
import { ApiError, createClient, type Client, type Schemas } from '@kesher/sdk';
import type { StaffSigner } from '../auth/staff-token.ts';
import { gatesFor } from '../providers/release-gates.ts';
import { AdminDataError, type AdminActor, type AdminData, type FlagState, type ProviderBinding } from './types.ts';

export interface HttpAdminDataOptions {
  baseUrl: string;
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

export function httpAdminData(o: HttpAdminDataOptions): AdminData {
  const client: Client = createClient({
    baseUrl: o.baseUrl,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    getAccessToken: async () => o.signer.sign(await o.actor()),
  });
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      return mapError(e);
    }
  };

  const data: AdminData = {
    searchCustomers: async () => notYet('Customer search'),
    getCustomer: async () => notYet('Customer 360'),
    listAlerts: async () => notYet('Alerts'),
    decideAlert: async () => notYet('Alerts'),
    listComplaints: async () => notYet('Complaints'),
    acknowledgeComplaint: async () => notYet('Complaints'),
    resolveComplaint: async () => notYet('Complaints'),

    async listBindings(): Promise<ProviderBinding[]> {
      const r = await run(() => client.get('/admin/bindings'));
      return r.items.map((b) => ({ capability: b.capability, binding: !b.provider || b.provider === 'simulator' ? 'simulator' : b.provider, degraded: false, contractGreenNights: 0 }));
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
  return data;
}

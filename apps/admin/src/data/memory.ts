// Seeded in-memory AdminData for local, preview and tests. Names and numbers are invented.
import { money } from '@kesher/domain';
import { PORTS } from '@kesher/ports';
import flagsRegistry from '../../../../config/flags.json' with { type: 'json' };
import { evaluateFlip, gatesFor } from '../providers/release-gates.ts';
import { AdminDataError, type AdminActor, type AdminData, type Alert, type Complaint, type CustomerRecord, type FlagState, type ProviderBinding } from './types.ts';

type AuditRow = { at: string; actor: string; action: string; subject: string; detail?: string | undefined };

const T0 = '2026-10-01T09:00:00Z';

const seedCustomers = (): CustomerRecord[] => [
  {
    partyId: '01932e5a-0000-7000-8000-000000000001',
    displayName: 'Noa Example',
    phone: '+972501234567',
    email: 'noa@example.com',
    locale: 'he',
    mode: 'member',
    createdAt: T0,
    kyc: { status: 'verified', provider: 'issuer-kyc', checkedAt: '2026-10-02T10:00:00Z' },
    memberships: [{ id: 'mem-1', planCode: 'club.basic', status: 'active', funderName: 'Dana Example', institutionName: 'Yeshivat Example', currentPeriodEnd: '2027-07-31T00:00:00Z' }],
    accounts: [
      { id: 'acc-usd', currency: 'USD', available: money(12_550n, 'USD'), holds: money(0n, 'USD') },
      { id: 'acc-ils', currency: 'ILS', available: money(34_000n, 'ILS'), holds: money(2_500n, 'ILS') },
    ],
    cards: [{ id: 'card-1', last4: '4242', type: 'virtual', status: 'active', tokens: 1 }],
    cases: [{ id: 'case-1', kind: 'recon_break', severity: 'medium', status: 'investigating', openedAt: '2026-10-28T06:00:00Z' }],
    consents: [
      { document: 'terms', version: '2026-09-01', acceptedAt: T0 },
      { document: 'privacy', version: '2026-09-01', acceptedAt: T0 },
    ],
    grants: [{ id: 'grant-1', clientName: 'Trip Planner', scopes: ['balances:read', 'esim:read'], lastUsedAt: '2026-10-31T20:00:00Z' }],
    audit: [
      { at: T0, actor: 'system', action: 'account.created' },
      { at: '2026-10-02T10:00:00Z', actor: 'system', action: 'kyc.verified', detail: 'issuer-kyc' },
      { at: '2026-10-30T08:00:00Z', actor: 'admin:ops-1', action: 'card.frozen', detail: 'member report, RUN-04' },
      { at: '2026-10-30T09:00:00Z', actor: 'admin:ops-1', action: 'card.unfrozen' },
    ],
  },
  {
    partyId: '01932e5a-0000-7000-8000-000000000002',
    displayName: 'Dana Example',
    phone: '+12125550123',
    email: 'dana@example.com',
    locale: 'en',
    mode: 'funder',
    createdAt: T0,
    kyc: { status: 'verified', provider: 'issuer-kyc', checkedAt: T0 },
    memberships: [],
    accounts: [{ id: 'acc-f-usd', currency: 'USD', available: money(250_000n, 'USD'), holds: money(0n, 'USD') }],
    cards: [],
    cases: [],
    consents: [{ document: 'terms', version: '2026-09-01', acceptedAt: T0 }],
    grants: [],
    audit: [{ at: T0, actor: 'system', action: 'account.created' }],
  },
];

const seedAlerts = (customers: readonly CustomerRecord[]): Alert[] => [
  { id: 'alert-1', kind: 'structuring', severity: 'high', status: 'open', partyId: customers[0]!.partyId, summary: '10 sends of ₪490 within one hour', openedAt: '2026-10-31T11:00:00Z' },
  { id: 'alert-2', kind: 'kyc_manual_review', severity: 'medium', status: 'open', summary: 'Document name differs from roster name', openedAt: '2026-10-30T09:30:00Z' },
  { id: 'alert-3', kind: 'sanctions_hit', severity: 'critical', status: 'in_review', summary: 'Partial name match on screening list', openedAt: '2026-10-29T14:00:00Z', decidedBy: 'admin:cmp-1', decidedAt: '2026-10-29T15:00:00Z' },
];

const seedComplaints = (customers: readonly CustomerRecord[]): Complaint[] => [
  { id: 'cmp-1', partyId: customers[0]!.partyId, channel: 'app', category: 'card_decline', summary: 'Card declined at pharmacy twice', openedAt: '2026-10-31T10:00:00Z', status: 'open' },
  { id: 'cmp-2', partyId: customers[0]!.partyId, channel: 'email', category: 'fees', summary: 'FX markup not shown before conversion', openedAt: '2026-10-14T10:00:00Z', acknowledgedAt: '2026-10-15T09:00:00Z', status: 'acknowledged', owner: 'admin:ops-2' },
  { id: 'cmp-3', partyId: customers[1]!.partyId, channel: 'bank', category: 'disclosure', summary: 'Asked for the accepted terms version as PDF', openedAt: '2026-09-20T10:00:00Z', acknowledgedAt: '2026-09-22T09:00:00Z', resolvedAt: '2026-10-05T12:00:00Z', status: 'resolved', owner: 'admin:cmp-1', escalatedToBank: true },
];

const seedBindings = (): ProviderBinding[] => PORTS.map((p) => ({ capability: p.capability, binding: p.capability === 'billing' ? 'stripe' : 'simulator', degraded: false, contractGreenNights: p.capability === 'billing' ? 9 : 0, ...(p.capability === 'billing' ? { lastContractRunAt: '2026-10-31T02:00:00Z' } : {}) }));

const seedFlags = (): FlagState[] => (flagsRegistry as { key: string; defaultProd: boolean }[]).map((f) => ({ key: f.key, on: f.defaultProd, gatesTicked: f.defaultProd ? gatesFor(f.key).map((g) => g.id) : [] }));

export function memoryAdminData(): AdminData {
  const customers = seedCustomers();
  const alerts = seedAlerts(customers);
  const complaints = seedComplaints(customers);
  const bindings = seedBindings();
  const flags = seedFlags();
  const audit: AuditRow[] = [];
  const log = (actor: AdminActor, action: string, subject: string, now: Date, detail?: string) => void audit.push({ at: now.toISOString(), actor: actor.subject, action, subject, ...(detail ? { detail } : {}) });
  const flag = (key: string) => {
    const f = flags.find((x) => x.key === key);
    if (!f) throw new AdminDataError('NOT_FOUND', `Unknown flag ${key}`);
    return f;
  };
  const complaint = (id: string) => {
    const c = complaints.find((x) => x.id === id);
    if (!c) throw new AdminDataError('NOT_FOUND', `Unknown complaint ${id}`);
    return c;
  };
  return {
    async searchCustomers(query) {
      const q = query.trim().toLowerCase();
      if (!q) return customers.map(summary);
      return customers.filter((c) => c.displayName.toLowerCase().includes(q) || c.phone.includes(q) || c.email?.toLowerCase().includes(q) || c.partyId === q).map(summary);
    },
    async getCustomer(partyId) {
      const c = customers.find((x) => x.partyId === partyId);
      return c ? structuredClone(c) : undefined;
    },
    async listAlerts() {
      return structuredClone(alerts);
    },
    async decideAlert(id, decision, by, note, now) {
      const a = alerts.find((x) => x.id === id);
      if (!a) throw new AdminDataError('NOT_FOUND', `Unknown alert ${id}`);
      if (a.status === 'cleared' || a.status === 'escalated') throw new AdminDataError('CONFLICT', 'Alert already decided');
      Object.assign(a, { status: decision, decidedBy: by.subject, decidedAt: now.toISOString(), note });
      log(by, `alert.${decision}`, id, now, note);
      return structuredClone(a);
    },
    async listComplaints() {
      return structuredClone(complaints);
    },
    async acknowledgeComplaint(id, by, now) {
      const c = complaint(id);
      if (c.status !== 'open') throw new AdminDataError('CONFLICT', 'Complaint is not open');
      Object.assign(c, { status: 'acknowledged', acknowledgedAt: now.toISOString(), owner: by.subject });
      log(by, 'complaint.acknowledged', id, now);
      return structuredClone(c);
    },
    async resolveComplaint(id, by, now) {
      const c = complaint(id);
      if (c.status === 'resolved' || c.status === 'withdrawn') throw new AdminDataError('CONFLICT', 'Complaint already closed');
      Object.assign(c, { status: 'resolved', resolvedAt: now.toISOString(), acknowledgedAt: c.acknowledgedAt ?? now.toISOString(), owner: c.owner ?? by.subject });
      log(by, 'complaint.resolved', id, now);
      return structuredClone(c);
    },
    async listBindings() {
      return structuredClone(bindings);
    },
    async listFlags() {
      return structuredClone(flags);
    },
    async getFlag(key) {
      const f = flags.find((x) => x.key === key);
      return f ? structuredClone(f) : undefined;
    },
    async tickGate(key, gateId, ticked, by, now) {
      const f = flag(key);
      if (!gatesFor(key).some((g) => g.id === gateId)) throw new AdminDataError('NOT_FOUND', `Unknown gate ${gateId}`);
      f.gatesTicked = ticked ? [...new Set([...f.gatesTicked, gateId])] : f.gatesTicked.filter((g) => g !== gateId);
      log(by, ticked ? 'gate.ticked' : 'gate.unticked', key, now, gateId);
      return structuredClone(f);
    },
    async proposeFlip(key, to, by, now) {
      const f = flag(key);
      if (f.pendingFlip) throw new AdminDataError('CONFLICT', 'A flip is already pending');
      if (to) {
        const v = evaluateFlip(key, f.gatesTicked, []);
        if (!v.gatesComplete) throw new AdminDataError('GATES_INCOMPLETE', `Release gates not ticked: ${v.missing.join(', ')}`);
      }
      f.pendingFlip = { requestId: `flip-${key}-${now.getTime()}`, to, requestedBy: by.subject, approvals: [by.subject], requestedAt: now.toISOString() };
      log(by, 'flag.flip.proposed', key, now, String(to));
      return structuredClone(f);
    },
    async approveFlip(key, by, now) {
      const f = flag(key);
      const p = f.pendingFlip;
      if (!p) throw new AdminDataError('NOT_FOUND', 'No pending flip');
      if (p.approvals.includes(by.subject)) throw new AdminDataError('SAME_APPROVER', 'The second approval must come from a different admin');
      p.approvals.push(by.subject);
      const v = evaluateFlip(key, f.gatesTicked, p.approvals);
      if (p.to && !v.ready) throw new AdminDataError('GATES_INCOMPLETE', `Release gates not ticked: ${v.missing.join(', ')}`);
      Object.assign(f, { on: p.to, pendingFlip: undefined, lastChangedAt: now.toISOString(), lastChangedBy: `${p.requestedBy}+${by.subject}` });
      log(by, 'flag.flip.applied', key, now, String(p.to));
      return structuredClone(f);
    },
    async killSwitch(key, by, now) {
      const f = flag(key);
      Object.assign(f, { on: false, pendingFlip: undefined, lastChangedAt: now.toISOString(), lastChangedBy: by.subject });
      log(by, 'flag.kill_switch', key, now);
      return structuredClone(f);
    },
    async auditLog() {
      return [...audit].reverse();
    },
  };
}

const summary = (c: CustomerRecord) => ({ partyId: c.partyId, displayName: c.displayName, phone: c.phone, email: c.email, locale: c.locale, mode: c.mode, createdAt: c.createdAt });


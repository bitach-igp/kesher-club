// Seeded in-memory AdminData for local, preview and tests. Names and numbers are invented.
import { money } from '@kesher/domain';
import { PORTS } from '@kesher/ports';
import flagsRegistry from '../../../../config/flags.json' with { type: 'json' };
import { evaluateFlip, gatesFor } from '../providers/release-gates.ts';
import { AdminDataError, type AdminActor, type AdminData, type Alert, type Complaint, type CustomerRecord, type Deposit, type FlagState, type InstitutionDetail, type KybView, type OpsCase, type PlanVersionRow, type PriceRuleRow, type ProviderBinding } from './types.ts';

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

// Per market (T-0913): IL bills through Stripe; US runs everything on the simulators.
const seedBindings = (): ProviderBinding[] =>
  (['IL', 'US'] as const).flatMap((market) =>
    PORTS.map((p) => {
      const live = market === 'IL' && p.capability === 'billing';
      return { capability: p.capability, market, binding: live ? 'stripe' : 'simulator', degraded: false, contractGreenNights: live ? 9 : 0, ...(live ? { lastContractRunAt: '2026-10-31T02:00:00Z' } : {}) };
    }),
  );

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
  // One seeded yeshiva (T-0615); its deposits follow the API's two-person rule so the screens behave alike.
  const priceRules: PriceRuleRow[] = [];
  // A13 (T-0933): one plan already offered, so the screen has something to supersede. Placeholder price (decision 5).
  const planVersions: PlanVersionRow[] = [
    { planCode: 'demo-club-il', name: 'Demo Club Israel (demo price)', version: 1, market: 'IL', price: money(18_000n, 'ILS'), termMonths: 10, entitlements: { 'esim.dataGb': { limit: '5', unit: 'gb', period: 'month' } }, fxMarkupBps: 75, effectiveFrom: T0, state: 'active', offered: true, proposedBy: 'staff-finance-1', reason: 'Demo seed', createdAt: T0, decidedAt: T0 },
  ];
  /** As the API works it out: the latest active version in force is the one offered. */
  const reoffer = (planCode: string, now: Date) => {
    const live = planVersions.filter((v) => v.planCode === planCode && v.state === 'active' && v.effectiveFrom <= now.toISOString()).sort((a, b) => b.version - a.version)[0];
    for (const v of planVersions.filter((x) => x.planCode === planCode)) v.offered = v === live;
  };
  const yeshiva: InstitutionDetail = { id: '01932e5a-0000-7000-8000-0000000000f1', name: 'Yeshivat Example', market: 'IL', activeStaff: 2, createdAt: T0, paymentReference: 'KC-7M4QX2HD', balances: [money(0n, 'ILS'), money(0n, 'USD')], deposits: [], depositsOff: false, staff: [], pendingGrants: 0 };
  const recorders = new Map<string, string>();
  // The ops queue (T-0931): a shekel credit the bank feed could not place, and a balance break. A suspense case
  // recorded as a deposit notes it and resolves when the deposit posts, as the API does (T-0631).
  const opsCases: OpsCase[] = [
    { id: '01932e5a-0000-7000-8000-0000000c5001', kind: 'suspense', severity: 'high', status: 'open', summary: 'ILS 5,000.00 by masav, no payment reference', payload: { reason: 'no_reference', provider: 'bank', creditId: 'sim-credit-1', rail: 'masav', amount: { minor: '500000', currency: 'ILS' }, bankReference: 'MSV-26110', valueDate: '2026-10-29', remitterReference: 'Tuition, see email' }, openedAt: '2026-10-30T06:00:00Z' },
    { id: '01932e5a-0000-7000-8000-0000000c5002', kind: 'balance_break', severity: 'high', status: 'open', summary: 'Balance differs from postings by ILS 0.01', payload: { accountId: 'acc-ils', difference: { minor: '1', currency: 'ILS' } }, openedAt: '2026-10-30T02:00:00Z' },
  ];
  const opsCase = (id: string): OpsCase => {
    const c = opsCases.find((x) => x.id === id);
    if (!c) throw new AdminDataError('NOT_FOUND', 'Case not found');
    return c;
  };
  const requireCaseWorker = (by: AdminActor) => {
    if (!by.roles.includes('ops') && !by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher ops or finance work cases');
  };
  const caseOpen = (c: OpsCase) => {
    if (c.status === 'resolved' || c.status === 'dismissed') throw new AdminDataError('CONFLICT', `This case is already ${c.status}`);
  };
  const depositView = (d: Deposit, by: AdminActor): Deposit => ({ ...d, recordedByMe: recorders.get(d.id) === by.subject });
  // Its KYB record (T-0926): the checks are clear but for one open hit on a board member, and Rivka, its control
  // person, has passed T1 only, so an approval is refused until both are dealt with. The blocking reasons are
  // worked out the way the API's are, for the hits and the control people; the API holds the full rule.
  const kyb: Omit<KybView, 'blocking' | 'pendingApproval'> = {
    decision: { status: 'needs_more_info', reasons: [] },
    people: [
      { id: 'kyb-p-1', fullName: 'Rivka Example', roles: ['control', 'signatory'], kycTier: 'T1' },
      { id: 'kyb-p-2', fullName: 'Board Member Example', roles: ['board'], kycTier: 'T2' },
    ],
    checks: [
      ...(['registry', 'identifier', 'exempt_status', 'sanctions', 'pep'] as const).map((kind) => ({ id: `kyb-c-${kind}`, kind, result: 'clear' as const, provider: 'simulator', evidenceRef: `sim:${kind}`, checkedAt: T0 })),
      ...(['kyb-p-1', 'kyb-p-2'] as const).flatMap((personId) => (['sanctions', 'pep'] as const).map((kind) => ({ id: `kyb-c-${kind}-${personId}`, kind, personId, result: 'clear' as const, provider: 'simulator', evidenceRef: `sim:${kind}`, checkedAt: T0 }))),
    ],
  };
  Object.assign(kyb.checks.find((c) => c.id === 'kyb-c-sanctions-kyb-p-2')!, { result: 'hit', evidenceRef: 'sim-screen:2:sdn' });
  let pending: { id: string; status: string; outcome: 'approved' | 'approved_with_limits'; risk: 'high'; proposer: string; reasons: string[] } | undefined;
  const blocking = (): string[] => [
    ...kyb.checks.filter((c) => c.result === 'hit' && !c.disposition).map((c) => `${c.kind}_hit_undisposed:${c.id}`),
    ...kyb.checks.filter((c) => c.kind === 'sanctions' && c.disposition?.outcome === 'true_match').map((c) => `sanctions_true_match:${c.id}`),
    ...kyb.people.filter((p) => p.roles.includes('control') && p.kycTier !== 'T2').map((p) => `control_person_not_t2:${p.id}`),
  ];
  const requireCompliance = (by: AdminActor) => {
    if (!by.roles.includes('compliance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher compliance decides KYB');
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
    async listInstitutions() {
      const { id, name, market, activeStaff, createdAt } = yeshiva;
      return [{ id, name, market, activeStaff, createdAt }];
    },
    async getInstitution(id, by) {
      return id === yeshiva.id ? { ...yeshiva, deposits: yeshiva.deposits.map((d) => depositView(d, by)) } : undefined;
    },
    async recordDeposit(institutionId, input, by, now) {
      if (institutionId !== yeshiva.id) throw new AdminDataError('NOT_FOUND', 'Institution not found');
      if (!by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher finance records deposits');
      const same = yeshiva.deposits.find((d) => d.rail === input.rail && d.bankReference === input.bankReference && d.status !== 'rejected');
      if (same) throw new AdminDataError('CONFLICT', 'This bank reference is already recorded on this rail');
      const from = input.caseId ? opsCases.find((c) => c.id === input.caseId) : undefined;
      if (input.caseId && (!from || from.kind !== 'suspense' || from.status === 'resolved' || from.status === 'dismissed')) throw new AdminDataError('INVALID', 'caseId must name an open suspense case');
      const d: Deposit = { id: `dep-${yeshiva.deposits.length + 1}`, amount: input.amount, rail: input.rail, bankReference: input.bankReference, valueDate: input.valueDate, ...(input.note ? { note: input.note } : {}), status: 'pending', approvals: 1, recordedByMe: true, createdAt: now.toISOString() };
      recorders.set(d.id, by.subject);
      yeshiva.deposits.unshift(d);
      if (from) Object.assign(from, { status: 'investigating', payload: { ...from.payload, depositId: d.id } });
      log(by, 'institution.deposit.record', institutionId, now, `${input.rail} ${input.bankReference}`);
      return depositView(d, by);
    },
    async decideDeposit(id, decision, by, reason, now) {
      const d = yeshiva.deposits.find((x) => x.id === id);
      if (!d) throw new AdminDataError('NOT_FOUND', 'Deposit not found');
      if (!by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher finance decides deposits');
      if (d.status !== 'pending') throw new AdminDataError('CONFLICT', `This deposit is already ${d.status}`);
      if (recorders.get(id) === by.subject) throw new AdminDataError('SAME_APPROVER', 'The recorder cannot approve or reject their own deposit');
      if (decision === 'reject') {
        if (!reason?.trim()) throw new AdminDataError('INVALID', 'A reason is required');
        Object.assign(d, { status: 'rejected', decidedAt: now.toISOString() });
      } else {
        Object.assign(d, { status: 'posted', approvals: 2, decidedAt: now.toISOString() });
        yeshiva.balances = yeshiva.balances.map((b) => (b.currency === d.amount.currency ? money(b.minor + d.amount.minor, b.currency) : b));
      }
      for (const c of opsCases.filter((x) => x.kind === 'suspense' && x.payload['depositId'] === d.id && (x.status === 'open' || x.status === 'investigating'))) {
        if (decision === 'reject') {
          const { depositId: _dropped, ...rest } = c.payload;
          c.payload = rest;
        } else Object.assign(c, { status: 'resolved', decidedBy: by.subject, decidedAt: now.toISOString(), note: `Recorded as deposit ${d.id}` });
      }
      log(by, `institution.deposit.${decision}`, yeshiva.id, now, reason);
      return depositView(d, by);
    },

    async listPlanVersions() {
      return structuredClone(planVersions);
    },
    async proposePlanVersion(input, by, now) {
      if (!by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher finance proposes plan versions');
      const same = planVersions.filter((v) => v.planCode === input.planCode);
      const v: PlanVersionRow = { planCode: input.planCode, name: same[0]?.name ?? input.name, version: same.length + 1, market: input.market, price: input.price, termMonths: input.termMonths, entitlements: input.entitlements, fxMarkupBps: input.fxMarkupBps, effectiveFrom: input.effectiveFrom ?? now.toISOString(), state: 'proposed', offered: false, proposedBy: by.subject, reason: input.reason, createdAt: now.toISOString() };
      planVersions.unshift(v);
      log(by, 'plan_version.propose', `${v.planCode}:${v.version}`, now, input.reason);
      return structuredClone(v);
    },
    async decidePlanVersion(planCode, version, decision, by, reason, now) {
      const v = planVersions.find((x) => x.planCode === planCode && x.version === version);
      if (!v) throw new AdminDataError('NOT_FOUND', 'Plan version not found');
      if (!by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher finance decides plan versions');
      if (v.state !== 'proposed') throw new AdminDataError('CONFLICT', `This version is already ${v.state}`);
      if (decision === 'approve' && v.proposedBy === by.subject) throw new AdminDataError('SAME_APPROVER', 'The proposer cannot approve their own version');
      if (decision === 'reject' && !reason?.trim()) throw new AdminDataError('INVALID', 'A reason is required');
      Object.assign(v, { state: decision === 'approve' ? 'active' : 'rejected', decidedAt: now.toISOString() });
      reoffer(planCode, now);
      log(by, `plan_version.${decision}`, `${planCode}:${version}`, now, reason);
      return structuredClone(v);
    },
    async listPriceRules() {
      return structuredClone(priceRules);
    },
    async proposePriceRule(input, by, now) {
      if (!by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher finance proposes price rules');
      const r: PriceRuleRow = { id: `rule-${priceRules.length + 1}`, ...input, state: 'proposed', proposedBy: by.subject, createdAt: now.toISOString() };
      priceRules.unshift(r);
      log(by, 'price_rule.propose', `${input.kind}:${input.provider}`, now, input.reason);
      return structuredClone(r);
    },
    async decidePriceRule(id, decision, by, reason, now) {
      const r = priceRules.find((x) => x.id === id);
      if (!r) throw new AdminDataError('NOT_FOUND', 'Price rule not found');
      if (!by.roles.includes('finance')) throw new AdminDataError('FORBIDDEN', 'Only Kesher finance decides price rules');
      if (r.state !== 'proposed') throw new AdminDataError('CONFLICT', `This rule is already ${r.state}`);
      if (decision === 'approve' && r.proposedBy === by.subject) throw new AdminDataError('SAME_APPROVER', 'The proposer cannot approve their own rule');
      if (decision === 'reject' && !reason?.trim()) throw new AdminDataError('INVALID', 'A reason is required');
      Object.assign(r, decision === 'approve' ? { state: 'active', activatedAt: now.toISOString() } : { state: 'rejected' });
      log(by, `price_rule.${decision}`, `${r.kind}:${r.provider}`, now, reason);
      return structuredClone(r);
    },

    async listOpsCases(filter, by) {
      return structuredClone(opsCases.filter((c) => (!filter.kind || c.kind === filter.kind) && (!filter.status || c.status === filter.status) && (!filter.mine || c.assignedTo === by.subject)));
    },
    async getOpsCase(id) {
      const c = opsCases.find((x) => x.id === id);
      return c ? structuredClone(c) : undefined;
    },
    async assignOpsCase(id, by, now) {
      requireCaseWorker(by);
      const c = opsCase(id);
      caseOpen(c);
      Object.assign(c, { status: 'investigating', assignedTo: by.subject, assignedAt: now.toISOString() });
      log(by, 'case.assign', id, now, by.subject);
      return structuredClone(c);
    },
    async decideOpsCase(id, decision, note, by, now) {
      requireCaseWorker(by);
      const c = opsCase(id);
      caseOpen(c);
      if (decision === 'resolved' && c.kind === 'suspense') throw new AdminDataError('INVALID', 'A suspense credit is resolved by recording it against an institution');
      if (!note.trim() || note.trim().length > 500) throw new AdminDataError('INVALID', 'A note of 1 to 500 characters is required');
      Object.assign(c, { status: decision, decidedBy: by.subject, decidedAt: now.toISOString(), note: note.trim() });
      log(by, `case.${decision}`, id, now, note.trim());
      return structuredClone(c);
    },

    async getKyb(id, by) {
      if (id !== yeshiva.id) return undefined;
      return structuredClone({ ...kyb, blocking: blocking(), ...(pending ? { pendingApproval: { id: pending.id, status: pending.status, outcome: pending.outcome, risk: pending.risk, proposedByMe: pending.proposer === by.subject } } : {}) });
    },
    async disposeKybCheck(checkId, outcome, note, by, now) {
      requireCompliance(by);
      const c = kyb.checks.find((x) => x.id === checkId);
      if (!c) throw new AdminDataError('NOT_FOUND', 'Check not found');
      if (c.disposition) throw new AdminDataError('CONFLICT', 'This hit is already disposed of');
      if (c.result !== 'hit' || !note.trim()) throw new AdminDataError('INVALID', 'Only a screening hit is disposed of, with a note');
      c.disposition = { outcome, note: note.trim(), decidedBy: by.subject, decidedAt: now.toISOString() };
      log(by, 'institution.kyb.dispose', yeshiva.id, now, outcome);
    },
    async decideKyb(institutionId, input, by, now) {
      if (institutionId !== yeshiva.id) throw new AdminDataError('NOT_FOUND', 'Institution not found');
      requireCompliance(by);
      const approval = input.status === 'approved' || input.status === 'approved_with_limits';
      if (approval && (!input.risk || blocking().length)) throw new AdminDataError('INVALID', 'The KYB record does not support an approval yet');
      if (!approval && !input.reasons.length) throw new AdminDataError('INVALID', 'Say why');
      if (approval && input.risk === 'high') {
        pending = { id: `kyb-apr-${now.getTime()}`, status: 'awaiting_second_approval', outcome: input.status as 'approved' | 'approved_with_limits', risk: 'high', proposer: by.subject, reasons: input.reasons };
        log(by, 'institution.kyb.propose', yeshiva.id, now, input.status);
        return 'awaiting_second_approval';
      }
      kyb.decision = { status: input.status, ...(approval ? { risk: input.risk } : {}), reasons: input.reasons, decidedAt: now.toISOString() };
      log(by, 'institution.kyb.decide', yeshiva.id, now, input.status);
      return 'decided';
    },
    async approveKybDecision(approvalId, by, now) {
      requireCompliance(by);
      if (!pending || pending.id !== approvalId) throw new AdminDataError('NOT_FOUND', 'KYB approval not found');
      if (pending.proposer === by.subject) throw new AdminDataError('SAME_APPROVER', 'The proposer cannot approve their own decision');
      kyb.decision = { status: pending.outcome, risk: pending.risk, reasons: pending.reasons, decidedAt: now.toISOString() };
      pending = undefined;
      log(by, 'institution.kyb.decide', yeshiva.id, now, 'second approval');
    },

    async auditLog() {
      return [...audit].reverse();
    },
  };
}

const summary = (c: CustomerRecord) => ({ partyId: c.partyId, displayName: c.displayName, phone: c.phone, email: c.email, locale: c.locale, mode: c.mode, createdAt: c.createdAt });


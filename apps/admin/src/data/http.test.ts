// httpAdminData (T-0906, ADR-013): every call carries a fresh 5-minute staff token for the acting
// admin, responses map to the console's shapes, and API problems become AdminDataError codes.
import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { money } from '@kesher/domain';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffSigner } from '../auth/staff-token.ts';
import { complaintSla, exportForBank } from '../compliance/sla.ts';
import { customer360 } from '../customers/customer360.ts';
import { flagState, httpAdminData } from './http.ts';

const NOA = '01932e5a-0000-7000-8000-000000000001';
const cmp1 = { id: '01932e5a-0000-7000-8000-00000000c001', partyId: NOA, channel: 'phone', category: 'card_decline', summary: 'Card declined at pharmacy twice', status: 'open', openedAt: '2026-10-28T10:00:00Z', loggedBy: 'ops-1', escalatedToBank: false };
const cmp2 = { id: '01932e5a-0000-7000-8000-00000000c002', partyId: NOA, channel: 'bank', category: 'disclosure', summary: 'Terms as PDF', status: 'resolved', openedAt: '2026-09-20T10:00:00Z', loggedBy: 'ops-1', acknowledgedAt: '2026-09-22T09:00:00Z', acknowledgedBy: 'cmp-1', resolvedAt: '2026-10-05T12:00:00Z', resolvedBy: 'cmp-1', owner: 'cmp-1', escalatedToBank: true };
const alert1 = { id: '01932e5a-0000-7000-8000-00000000a001', kind: 'structuring', severity: 'high', status: 'open', partyId: NOA, summary: '10 sends of ₪490 within one hour', openedAt: '2026-10-31T11:00:00Z' };
const YESHIVA = '01932e5a-0000-7000-8000-0000000000f1';
const dep1 = { id: '01932e5a-0000-7000-8000-00000000d001', institutionId: YESHIVA, amount: { minor: '9007199254740993', currency: 'ILS' }, rail: 'masav', bankReference: 'FT2611-ABC', valueDate: '2026-11-09', status: 'pending', approvals: 1, recordedByMe: true, createdAt: '2026-11-10T09:00:00Z' };
const problemOf = (status: number, code: string, detail: string) => Response.json({ type: 'about:blank', title: code, status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });
const noaSummary = { partyId: NOA, displayName: 'Noa Example', phoneMasked: '•••• 4567', status: 'active', locale: 'he', mode: 'member', createdAt: '2026-10-01T09:00:00Z' };
const noa360 = {
  ...noaSummary,
  restrictedUntil: '2026-11-02T00:00:00Z',
  kyc: { status: 'none' },
  memberships: [{ id: 'mem-1', planCode: 'club', status: 'active', role: 'member', counterpartyId: '01932e5a-0000-7000-8000-000000000002', institutionName: 'Yeshivat Example' }],
  purses: [{ id: 'acc-usd', currency: 'USD', available: { minor: '8000', currency: 'USD' }, holds: { minor: '2000', currency: 'USD' } }],
  cards: [],
  openCases: [{ id: 'case-1', kind: 'balance_break', severity: 'high', status: 'open', openedAt: '2026-10-28T06:00:00Z' }],
  consents: [{ document: 'terms', version: 1, hash: 'h1', acceptedAt: '2026-10-01T09:00:00Z' }],
  grants: [{ id: 'grant-1', clientName: 'Trip Planner', clientId: 'https://trip.example/client.json', scopes: ['balances:read'], createdAt: '2026-10-01T09:00:00Z', revokedAt: '2026-10-15T00:00:00Z' }],
  audit: [{ at: '2026-10-30T09:00:00Z', actorId: 'p-ops-1', actorRole: 'admin', action: 'card.unfrozen', reason: 'cleared' }],
};

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const signer = await staffSigner(await exportJWK(privateKey), 'admin-1');
  const calls: { host: string; url: string; method: string; auth: string | undefined; body?: unknown }[] = [];
  const flags = [
    { key: 'esim.airalo', value: false, default: false, owner: 'Kathleen', gates: 'eSIM purchase', money: false },
    { key: 'billing.stripe', value: true, default: true, owner: 'Ezra', gates: 'Subscriptions', money: false, changedAt: '2026-11-01T09:00:00Z', pendingFlip: { id: 'req-1', kind: 'flag_flip', subject: 'billing.stripe:false:2026-11-01', status: 'awaiting_second_approval', approvals: 1, requestedBy: 'p-ops-1', expiresAt: '2026-11-02T09:00:00Z', payload: { to: false } } },
  ];
  let depositsOn = true;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    url.pathname = url.pathname.replace(/^\/v1/, '');
    const headers = new Headers(init?.headers);
    const market = url.host === 'api-us.kesher.example' ? 'US' : 'IL';
    calls.push({ host: url.host, url: url.pathname + url.search, method: init?.method ?? 'GET', auth: headers.get('authorization') ?? undefined, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.pathname === '/admin/flags') return Response.json({ items: flags });
    // Each market's API reports its own bindings: IL bills through Stripe, US is still on the simulator.
    if (url.pathname === '/admin/bindings') return Response.json({ items: [{ capability: 'billing', port: 'BillingPort', direction: 'out', vendors: ['stripe'], flags: ['billing.stripe'], market, provider: market === 'IL' ? 'stripe' : 'simulator', mode: market === 'IL' ? 'sandbox' : 'sim' }, { capability: 'esim', port: 'EsimPort', direction: 'out', vendors: ['airalo'], flags: ['esim.airalo'], market, provider: 'simulator', mode: 'sim' }] });
    if (url.pathname === '/admin/flags/not.a.flag/flips') return Response.json({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND', detail: 'Unknown flag' }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
    if (url.pathname.endsWith('/flips')) return Response.json({ id: 'req-2', kind: 'flag_flip', subject: 'x', status: 'awaiting_second_approval', approvals: 1, requestedBy: 'p', expiresAt: '2026-11-02T09:00:00Z', payload: { to: true } }, { status: 201 });
    if (url.pathname === '/admin/flag-flips/req-1/approve') return Response.json({ id: 'req-1', kind: 'flag_flip', subject: 'x', status: 'approved', approvals: 2, requestedBy: 'p', expiresAt: '2026-11-02T09:00:00Z', payload: { to: false } });
    if (url.pathname === '/admin/customers') return Response.json({ items: url.searchParams.get('q') === 'noa' ? [noaSummary] : [] });
    if (url.pathname === `/admin/customers/${NOA}`) return Response.json(noa360);
    if (url.pathname.startsWith('/admin/customers/')) return Response.json({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND', detail: 'Customer not found' }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
    if (url.pathname === '/admin/complaints') return Response.json({ items: [cmp1, cmp2] });
    if (url.pathname === `/admin/complaints/${cmp1.id}/acknowledge`) return Response.json({ ...cmp1, status: 'acknowledged', acknowledgedAt: '2026-11-02T09:00:00Z', acknowledgedBy: 'zvi', owner: 'zvi' });
    if (url.pathname === `/admin/complaints/${cmp2.id}/resolve`) return Response.json({ type: 'about:blank', title: 'Conflict', status: 409, code: 'IDEMPOTENCY_CONFLICT', detail: 'Complaint already closed' }, { status: 409, headers: { 'content-type': 'application/problem+json' } });
    if (url.pathname === '/admin/alerts') return Response.json({ items: [alert1] });
    if (url.pathname === `/admin/alerts/${alert1.id}/decisions`) return Response.json({ ...alert1, status: 'cleared', decidedBy: 'zvi', decidedAt: '2026-11-02T09:00:00Z', note: 'tuition' });
    if (url.pathname === '/admin/institutions') return Response.json({ items: [{ id: YESHIVA, name: 'Yeshivat Example', market: 'IL', activeStaff: 2, createdAt: '2026-11-01T09:00:00Z' }] });
    if (url.pathname === `/admin/institutions/${YESHIVA}/staff`) return Response.json({ items: [{ partyId: NOA, institutionId: YESHIVA, role: 'finance', active: true, createdAt: '2026-11-01T09:00:00Z', phoneMasked: '•••• 4567' }], pendingGrants: [] });
    if (url.pathname === `/admin/institutions/${YESHIVA}/deposits` && init?.method === 'POST') return headers.get('idempotency-key') === 'form-key-1' ? Response.json(dep1, { status: 201 }) : problemOf(409, 'IDEMPOTENCY_CONFLICT', 'That bank reference is already recorded on this rail');
    if (url.pathname === `/admin/institutions/${YESHIVA}/deposits`) return depositsOn ? Response.json({ paymentReference: 'KC-7M4QX2HD', balances: [{ minor: '2000000', currency: 'ILS' }], items: [dep1] }) : problemOf(404, 'FEATURE_OFF', 'institutions.deposits is off');
    if (url.pathname === `/admin/deposits/${dep1.id}/approve`) return problemOf(409, 'IDEMPOTENCY_CONFLICT', 'The recorder cannot approve');
    if (url.pathname === `/admin/deposits/${dep1.id}/reject`) return Response.json({ ...dep1, status: 'rejected', recordedByMe: false, decidedAt: '2026-11-10T10:00:00Z' });
    if (url.pathname === '/admin/audit') return Response.json({ items: [{ seq: 1, id: 'e1', at: '2026-11-01T09:00:00Z', actorId: 'p-ops-2', actorRole: 'admin', action: 'flag.flip', subject: url.searchParams.get('subject'), reason: 'go live', payload: {}, hash: 'h', prevHash: 'genesis' }] });
    return new Response('nope', { status: 500 });
  };
  const data = httpAdminData({ apis: { IL: 'https://api-il.kesher.example/v1', US: 'https://api-us.kesher.example/v1' }, signer, actor: async () => ({ subject: 'zvi', roles: ['ops'] }), fetch: fetchImpl });
  return { data, calls, publicKey, depositsOff: () => void (depositsOn = false) };
}

describe('httpAdminData', () => {
  it('signs a staff token for the acting admin on every call', async () => {
    const { data, calls, publicKey } = await setup();
    await data.listFlags();
    const auth = calls[0]?.auth ?? '';
    expect(auth).toMatch(/^Bearer /);
    const { payload } = await jwtVerify(auth.slice(7), publicKey, { issuer: STAFF_ISSUER, audience: STAFF_AUDIENCE, algorithms: ['ES256'] });
    expect(payload).toMatchObject({ sub: 'zvi', roles: ['ops'] });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it('maps flags, pending flips, bindings and audit to the console shapes', async () => {
    const { data } = await setup();
    const flags = await data.listFlags();
    expect(flags.find((f) => f.key === 'esim.airalo')).toMatchObject({ on: false, gatesTicked: [] });
    expect(flags.find((f) => f.key === 'billing.stripe')).toMatchObject({ on: true, lastChangedAt: '2026-11-01T09:00:00Z', pendingFlip: { requestId: 'req-1', to: false, requestedBy: 'p-ops-1' } });
    expect((await data.listBindings()).map((b) => [b.market, b.capability, b.binding])).toEqual([
      ['IL', 'billing', 'stripe'],
      ['IL', 'esim', 'simulator'],
      ['US', 'billing', 'simulator'],
      ['US', 'esim', 'simulator'],
    ]);
    const log = await data.auditLog();
    expect(log).toEqual([{ at: '2026-11-01T09:00:00Z', actor: 'p-ops-2', action: 'flag.flip', subject: 'billing.stripe', detail: 'go live' }]);
    expect(flagState({ key: 'wallet.enabled', value: true, default: false, owner: 'o', gates: 'g', money: true }).gatesTicked).toHaveLength(10);
    expect(flagState({ key: 'esim.airalo', value: true, default: false, owner: 'o', gates: 'g', money: false }).gatesTicked).toHaveLength(8);
  });

  it('proposes, approves and kills through the API and maps problems to AdminDataError', async () => {
    const { data, calls } = await setup();
    await data.proposeFlip('esim.airalo', true, { subject: 'zvi', roles: ['ops'] }, new Date());
    expect(calls.find((c) => c.url === '/admin/flags/esim.airalo/flips')).toMatchObject({ method: 'POST', body: { to: true } });
    await data.approveFlip('billing.stripe', { subject: 'zvi', roles: ['ops'] }, new Date());
    expect(calls.some((c) => c.url === '/admin/flag-flips/req-1/approve')).toBe(true);
    await data.killSwitch('billing.stripe', { subject: 'zvi', roles: ['ops'] }, new Date());
    expect(calls.find((c) => c.url === '/admin/flags/billing.stripe/flips')?.body).toEqual({ to: false, reason: 'Proposed from the admin console' });
    await expect(data.proposeFlip('not.a.flag', true, { subject: 'zvi', roles: [] }, new Date())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads and decides alerts, reads, acknowledges and resolves complaints, and feeds the bank export from the same rows', async () => {
    const { data, calls } = await setup();
    const by = { subject: 'zvi', roles: ['ops'] };
    expect(await data.listAlerts()).toEqual([{ id: alert1.id, kind: 'structuring', severity: 'high', status: 'open', partyId: NOA, summary: '10 sends of ₪490 within one hour', openedAt: '2026-10-31T11:00:00Z', decidedBy: undefined, decidedAt: undefined, note: undefined }]);
    expect(await data.decideAlert(alert1.id, 'cleared', by, 'tuition', new Date())).toMatchObject({ status: 'cleared', decidedBy: 'zvi', note: 'tuition' });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `/admin/alerts/${alert1.id}/decisions`, body: { decision: 'cleared', note: 'tuition' } });

    const complaints = await data.listComplaints();
    expect(complaints.map((c) => [c.id, c.status, c.owner])).toEqual([
      [cmp1.id, 'open', undefined],
      [cmp2.id, 'resolved', 'cmp-1'],
    ]);
    expect(await data.acknowledgeComplaint(cmp1.id, by, new Date())).toMatchObject({ status: 'acknowledged', acknowledgedAt: '2026-11-02T09:00:00Z', owner: 'zvi' });
    await expect(data.resolveComplaint(cmp2.id, by, new Date())).rejects.toMatchObject({ code: 'CONFLICT' });
    // The SLA clocks run from the API's openedAt; the export has one row per listed complaint.
    const now = new Date('2026-11-02T09:00:00Z');
    expect(complaintSla(complaints[0]!, now)).toMatchObject({ ackDue: '2026-10-30T23:59:59.999Z', ackBreached: true, resolveColour: 'green' });
    const csv = exportForBank(complaints, now).trim().split('\r\n');
    expect(csv).toHaveLength(1 + complaints.length);
    expect(csv[1]).toContain(`${cmp1.id},${NOA},phone,card_decline,Card declined at pharmacy twice,2026-10-28T10:00:00Z,`);
  });

  it('searches and reads customers through the API, keeping the phone masked end to end', async () => {
    const { data, calls } = await setup();
    expect(await data.searchCustomers('   ')).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await data.searchCustomers('nobody')).toEqual([]);
    const [noa] = await data.searchCustomers('noa');
    expect(noa).toEqual({ partyId: NOA, displayName: 'Noa Example', phone: '•••• 4567', locale: 'he', mode: 'member', createdAt: '2026-10-01T09:00:00Z' });
    expect(calls.at(-1)?.url).toBe('/admin/customers?q=noa');
    const record = (await data.getCustomer(NOA))!;
    expect(record.accounts).toEqual([{ id: 'acc-usd', currency: 'USD', available: money(8_000n, 'USD'), holds: money(2_000n, 'USD') }]);
    expect(record.memberships).toEqual([{ id: 'mem-1', planCode: 'club', status: 'active', institutionName: 'Yeshivat Example', currentPeriodEnd: undefined }]);
    expect(record.consents).toEqual([{ document: 'terms', version: '1', acceptedAt: '2026-10-01T09:00:00Z' }]);
    expect(record.audit).toEqual([{ at: '2026-10-30T09:00:00Z', actor: 'p-ops-1', action: 'card.unfrozen', detail: 'cleared' }]);
    const view = customer360(record, new Date('2026-11-01T09:00:00Z'));
    expect(view.phoneMasked).toBe('•••• 4567');
    expect(view.emailMasked).toBeUndefined();
    expect(view.flags).toEqual(['recovery_hold', 'kyc_none', 'open_case']);
    expect(view.balances).toEqual([{ id: 'acc-usd', currency: 'USD', available: '$80.00', holds: '$20.00', spendable: '$60.00' }]);
    expect(view.activeGrants).toEqual([]);
    expect(await data.getCustomer('01932e5a-0000-7000-8000-00000000dead')).toBeUndefined();
  });

  it('sends club-wide calls to the IL API only, and keeps a client per market for provider actions (T-0913)', async () => {
    const { data, calls } = await setup();
    await data.listFlags();
    await data.searchCustomers('noa');
    await data.listComplaints();
    await data.listAlerts();
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(['api-il.kesher.example']));
    calls.length = 0;
    await data.listBindings();
    expect(calls.map((c) => c.host).sort()).toEqual(['api-il.kesher.example', 'api-us.kesher.example']);
    calls.length = 0;
    await data.apiFor('US').get('/admin/bindings');
    expect(calls).toEqual([expect.objectContaining({ host: 'api-us.kesher.example', url: '/admin/bindings' })]);
  });

  it('reads an institution with its deposits in bigint, sends the form key as the Idempotency-Key, and serves the page with deposits off (T-0615)', async () => {
    const { data, calls, depositsOff } = await setup();
    const zvi = { subject: 'zvi', roles: ['finance'] };
    const detail = (await data.getInstitution(YESHIVA, zvi))!;
    expect(detail).toMatchObject({ name: 'Yeshivat Example', paymentReference: 'KC-7M4QX2HD', balances: [money(2_000_000n, 'ILS')], depositsOff: false, staff: [{ partyId: NOA, role: 'finance', active: true }], pendingGrants: 0 });
    expect(detail.deposits[0]).toMatchObject({ amount: money(9_007_199_254_740_993n, 'ILS'), status: 'pending', recordedByMe: true });
    expect(await data.getInstitution('nope', zvi)).toBeUndefined();

    calls.length = 0;
    const input = { amount: money(2_000_000n, 'ILS'), rail: 'masav' as const, bankReference: 'FT2611-ABC', valueDate: '2026-11-09', key: 'form-key-1' };
    await data.recordDeposit(YESHIVA, input, zvi, new Date());
    expect(calls[0]).toMatchObject({ method: 'POST', body: { amount: { minor: '2000000', currency: 'ILS' }, rail: 'masav', bankReference: 'FT2611-ABC', valueDate: '2026-11-09' } });
    await expect(data.recordDeposit(YESHIVA, { ...input, key: 'form-key-2' }, zvi, new Date())).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(data.decideDeposit(dep1.id, 'approve', zvi, undefined, new Date())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await data.decideDeposit(dep1.id, 'reject', zvi, 'Wrong amount', new Date())).toMatchObject({ status: 'rejected' });
    expect(calls.at(-1)).toMatchObject({ body: { reason: 'Wrong amount' } });

    depositsOff();
    expect(await data.getInstitution(YESHIVA, zvi)).toMatchObject({ depositsOff: true, deposits: [], balances: [], staff: [{ partyId: NOA }] });
  });
});

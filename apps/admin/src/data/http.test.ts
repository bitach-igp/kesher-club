// httpAdminData (T-0906, ADR-013): every call carries a fresh 5-minute staff token for the acting
// admin, responses map to the console's shapes, and API problems become AdminDataError codes.
import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { money } from '@kesher/domain';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffSigner } from '../auth/staff-token.ts';
import { customer360 } from '../customers/customer360.ts';
import { flagState, httpAdminData } from './http.ts';

const NOA = '01932e5a-0000-7000-8000-000000000001';
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
  const calls: { url: string; method: string; auth: string | undefined; body?: unknown }[] = [];
  const flags = [
    { key: 'esim.airalo', value: false, default: false, owner: 'Kathleen', gates: 'eSIM purchase', money: false },
    { key: 'billing.stripe', value: true, default: true, owner: 'Ezra', gates: 'Subscriptions', money: false, changedAt: '2026-11-01T09:00:00Z', pendingFlip: { id: 'req-1', kind: 'flag_flip', subject: 'billing.stripe:false:2026-11-01', status: 'awaiting_second_approval', approvals: 1, requestedBy: 'p-ops-1', expiresAt: '2026-11-02T09:00:00Z', payload: { to: false } } },
  ];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    url.pathname = url.pathname.replace(/^\/v1/, '');
    const headers = new Headers(init?.headers);
    calls.push({ url: url.pathname + url.search, method: init?.method ?? 'GET', auth: headers.get('authorization') ?? undefined, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.pathname === '/admin/flags') return Response.json({ items: flags });
    if (url.pathname === '/admin/bindings') return Response.json({ items: [{ capability: 'billing', port: 'BillingPort', direction: 'out', vendors: ['stripe'], flags: ['billing.stripe'], market: 'IL', provider: 'stripe', mode: 'sandbox' }, { capability: 'esim', port: 'EsimPort', direction: 'out', vendors: ['airalo'], flags: ['esim.airalo'], market: 'IL', provider: 'simulator', mode: 'sim' }] });
    if (url.pathname === '/admin/flags/not.a.flag/flips') return Response.json({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND', detail: 'Unknown flag' }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
    if (url.pathname.endsWith('/flips')) return Response.json({ id: 'req-2', kind: 'flag_flip', subject: 'x', status: 'awaiting_second_approval', approvals: 1, requestedBy: 'p', expiresAt: '2026-11-02T09:00:00Z', payload: { to: true } }, { status: 201 });
    if (url.pathname === '/admin/flag-flips/req-1/approve') return Response.json({ id: 'req-1', kind: 'flag_flip', subject: 'x', status: 'approved', approvals: 2, requestedBy: 'p', expiresAt: '2026-11-02T09:00:00Z', payload: { to: false } });
    if (url.pathname === '/admin/customers') return Response.json({ items: url.searchParams.get('q') === 'noa' ? [noaSummary] : [] });
    if (url.pathname === `/admin/customers/${NOA}`) return Response.json(noa360);
    if (url.pathname.startsWith('/admin/customers/')) return Response.json({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND', detail: 'Customer not found' }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
    if (url.pathname === '/admin/audit') return Response.json({ items: [{ seq: 1, id: 'e1', at: '2026-11-01T09:00:00Z', actorId: 'p-ops-2', actorRole: 'admin', action: 'flag.flip', subject: url.searchParams.get('subject'), reason: 'go live', payload: {}, hash: 'h', prevHash: 'genesis' }] });
    return new Response('nope', { status: 500 });
  };
  const data = httpAdminData({ baseUrl: 'https://api.kesher.example/v1', signer, actor: async () => ({ subject: 'zvi', roles: ['ops'] }), fetch: fetchImpl });
  return { data, calls, publicKey };
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
    expect((await data.listBindings()).map((b) => [b.capability, b.binding])).toEqual([
      ['billing', 'stripe'],
      ['esim', 'simulator'],
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
    await expect(data.listAlerts()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
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
});

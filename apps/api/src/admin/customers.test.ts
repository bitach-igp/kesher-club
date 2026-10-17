// Customer search and Customer 360 through /admin/customers (T-0907, ADR-013), end to end over the
// dispatcher and PGlite. The model is assembled from the identity repository, billing, the ledger,
// ops cases, legal consents, agent grants and the audit chain; it never carries a full phone or a PAN.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { InMemoryIdentityRepository } from '../auth/repository.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER } from './staff-token.ts';
import { maskPhone, type Customer360, type CustomerSummary } from './customers.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-01T09:00:00Z');
const T0 = new Date('2026-10-01T09:00:00Z');
const identity = new InMemoryIdentityRepository();
const noa = uuidv7(T0);
const dana = uuidv7(T0);
const NOA_PHONE = '+972501234567';
const DANA_PHONE = '+12125550123';
const institution = uuidv7(T0);

const staffToken = async (sub: string, roles: string[] = ['ops']) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (url: string, token?: string) => dispatch(app, { method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: '', now: NOW });
const search = async (q: string) => (await call(`/v1/admin/customers?q=${encodeURIComponent(q)}`, await staffToken('ops-1'))).body as { items: CustomerSummary[] };

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', identity, staffJwks: [jwk], clock: () => NOW });
  const s = app.services;

  await identity.createUser({ partyId: noa, phone: NOA_PHONE, status: 'active', roles: ['member'], createdAt: T0.toISOString() });
  await identity.createUser({ partyId: dana, phone: DANA_PHONE, status: 'active', roles: ['member'], createdAt: T0.toISOString() });
  await identity.setRestriction(noa, '2026-11-02T00:00:00Z', 'otp_recovery');

  // Roster: Noa is on Yeshivat Example's list under her name; Dana invited by email.
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [institution]);
  const memberRow = uuidv7(T0);
  await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, funder_party_id, status) values ($1, $2, 'Noa Example', $3, $4, 'active')`, [memberRow, institution, noa, dana]);
  await db.query(`insert into org.invite (id, idempotency_key, member_id, channel, recipient_hash, token_hash, status, sent_at, expires_at) values ($1, 'inv-1', $2, 'email', $3, 'tok-1', 'accepted', $4, $5)`, [uuidv7(T0), memberRow, createHash('sha256').update('noa@example.com').digest('base64url'), T0, NOW]);

  // Billing: Dana funds Noa's club membership.
  await s.plans.ensurePlan('club', 'Kesher Club');
  await s.plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  await s.memberships.create({ idempotencyKey: 'm-noa', memberPartyId: noa, funderPartyId: dana, funderEmail: 'dana@example.com', planCode: 'club' }, T0);

  // Ledger: a $100 load and a $20 hold on Noa's USD purse; nothing in ILS.
  await s.accounts.provisionMember(noa);
  const wallet = await s.accounts.memberAccount(noa, 'wallet', 'USD');
  const pending = await s.accounts.memberAccount(noa, 'pending', 'USD');
  const partner = await s.accounts.systemAccount('partner_settlement', 'USD');
  await s.ledger.post({ idempotencyKey: 'load:noa', kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 10_000n }, { accountId: wallet, currency: 'USD', amountMinor: -10_000n }] });
  await s.ledger.post({ idempotencyKey: 'hold:noa', kind: 'auth_hold', postings: [{ accountId: wallet, currency: 'USD', amountMinor: 2_000n }, { accountId: pending, currency: 'USD', amountMinor: -2_000n }] });

  // Ops: one open balance break on Noa's wallet, one resolved; a recon break with no party.
  await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'balance_break', 'bb:open', 'high', 'open', $2, $3)`, [uuidv7(NOW), JSON.stringify({ accountId: wallet, deltaMinor: '1' }), '2026-10-28T06:00:00Z']);
  await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at, resolved_at) values ($1, 'balance_break', 'bb:done', 'high', 'resolved', $2, $3, $3)`, [uuidv7(NOW), JSON.stringify({ accountId: wallet }), '2026-10-20T06:00:00Z']);
  await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'recon_break', 'recon:x', 'medium', 'open', '{}', $2)`, [uuidv7(NOW), '2026-10-29T06:00:00Z']);

  // Legal: terms v1 accepted in Hebrew.
  await db.query(`insert into legal.document_version (doc_key, version, title_en, title_he, body_en, body_he, hash, material, published_by, effective_at, published_at) values ('terms', 1, 'Terms', 'תנאים', 'b', 'b', 'h1', true, $1, $2, $2)`, [uuidv7(T0), T0]);
  await db.query(`insert into legal.consent (id, party_id, doc_key, version, hash, device_id, ip, locale, accepted_at) values ($1, $2, 'terms', 1, 'h1', 'iphone-1', '203.0.113.9', 'he', $3)`, [uuidv7(T0), noa, T0]);

  // Agent: one live grant and one revoked.
  await db.query(`insert into agent.client (client_id, name, metadata, fetched_at) values ('https://trip.example/client.json', 'Trip Planner', '{}', $1)`, [T0]);
  await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at, last_used_at) values ($1, 'https://trip.example/client.json', $2, $3, 'active', $4, $5)`, [uuidv7(T0), noa, ['balances:read'], T0, '2026-10-31T20:00:00Z']);
  await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at, revoked_at) values ($1, 'https://trip.example/client.json', $2, $3, 'revoked', $4, $5)`, [uuidv7(T0), noa, ['esim:read'], T0, '2026-10-15T00:00:00Z']);

  // Audit: party-scoped entries use the party id as the subject.
  await s.audit.record({ actorId: dana, actorRole: 'admin', action: 'card.frozen', subject: noa, reason: 'member report', payload: {} }, new Date('2026-10-30T08:00:00Z'));
  await s.audit.record({ actorId: dana, actorRole: 'admin', action: 'card.unfrozen', subject: noa, reason: 'cleared', payload: {} }, new Date('2026-10-30T09:00:00Z'));
}, 60_000);
afterAll(async () => db.close());

describe('GET /admin/customers (search)', () => {
  it('finds by exact phone, party id, roster name and invite email; nothing for the rest', async () => {
    expect((await search(NOA_PHONE)).items.map((c) => c.partyId)).toEqual([noa]);
    expect((await search(noa.toUpperCase())).items.map((c) => c.partyId)).toEqual([noa]);
    expect((await search('noa ex')).items.map((c) => c.partyId)).toEqual([noa]);
    expect((await search('NOA@Example.com')).items.map((c) => c.partyId)).toEqual([noa]);
    expect((await search('0501234567')).items).toEqual([]);
    expect((await search('%')).items).toEqual([]);
    expect((await search('nobody')).items).toEqual([]);
  });

  it('returns summaries with a masked phone and a roster or fallback name', async () => {
    const [c] = (await search(NOA_PHONE)).items;
    expect(c).toEqual({ partyId: noa, displayName: 'Noa Example', phoneMasked: '•••• 4567', status: 'active', locale: 'he', mode: 'member', createdAt: T0.toISOString() });
    expect(JSON.stringify(c)).not.toContain('+972');
    const [f] = (await search(DANA_PHONE)).items;
    expect(f).toMatchObject({ partyId: dana, displayName: 'Member •••• 0123', mode: 'funder', locale: 'en' });
    expect(maskPhone('+12125550123')).toBe('•••• 0123');
  });

  it('needs a staff token and a query', async () => {
    expect((await call('/v1/admin/customers?q=x')).status).toBe(401);
    expect((await call('/v1/admin/customers', await staffToken('ops-1'))).status).toBe(422);
  });
});

describe('GET /admin/customers/{id} (Customer 360)', () => {
  it('assembles memberships, purses, open cases, consents, grants, the recovery hold and the audit tail', async () => {
    const r = await call(`/v1/admin/customers/${noa}`, await staffToken('ops-1'));
    expect(r.status).toBe(200);
    const c = r.body as Customer360;
    expect(c).toMatchObject({ partyId: noa, displayName: 'Noa Example', phoneMasked: '•••• 4567', restrictedUntil: '2026-11-02T00:00:00Z', kyc: { status: 'none' }, cards: [] });
    expect(c.memberships).toEqual([expect.objectContaining({ planCode: 'club', status: 'active', role: 'member', counterpartyId: dana, institutionName: 'Yeshivat Example' })]);
    expect(c.purses).toEqual([
      { id: expect.any(String), currency: 'ILS', available: { minor: '0', currency: 'ILS' }, holds: { minor: '0', currency: 'ILS' } },
      { id: expect.any(String), currency: 'USD', available: { minor: '8000', currency: 'USD' }, holds: { minor: '2000', currency: 'USD' } },
    ]);
    expect(c.openCases).toEqual([{ id: expect.any(String), kind: 'balance_break', severity: 'high', status: 'open', openedAt: '2026-10-28T06:00:00.000Z' }]);
    expect(c.consents).toEqual([{ document: 'terms', version: 1, hash: 'h1', acceptedAt: T0.toISOString() }]);
    expect(c.grants.map((g) => [g.clientName, g.scopes[0], g.revokedAt ?? 'live'])).toEqual([
      ['Trip Planner', 'balances:read', 'live'],
      ['Trip Planner', 'esim:read', '2026-10-15T00:00:00.000Z'],
    ]);
    expect(c.audit.map((e) => e.action)).toEqual(['card.unfrozen', 'card.frozen']);
    // No full phone, no card-number-shaped digit run anywhere in the document.
    const json = JSON.stringify(c);
    expect(json).not.toContain(NOA_PHONE);
    expect(json).not.toMatch(/\d{13,19}/);
  });

  it('a funder with no purses or roster row still reads', async () => {
    const c = (await call(`/v1/admin/customers/${dana}`, await staffToken('ops-1'))).body as Customer360;
    expect(c).toMatchObject({ displayName: 'Member •••• 0123', mode: 'funder', purses: [], openCases: [], consents: [], grants: [], audit: [] });
    expect(c.memberships).toEqual([expect.objectContaining({ role: 'funder', counterpartyId: noa })]);
    expect(c.restrictedUntil).toBeUndefined();
  });

  it('404s for an unknown party and never provisions anything on read', async () => {
    const ghost = uuidv7(NOW);
    expect((await call(`/v1/admin/customers/${ghost}`, await staffToken('ops-1'))).status).toBe(404);
    expect((await db.query(`select count(*)::int as n from ledger.account where owner_party_id = $1`, [ghost])).rows[0]).toEqual({ n: 0 });
    expect((await db.query(`select count(*)::int as n from ledger.account where owner_party_id = $1`, [dana])).rows[0]).toEqual({ n: 0 });
  });

  it('refuses a member token', async () => {
    const member = await app.services.tokens.issue({ partyId: noa, roles: ['member'], deviceId: 'd1' });
    const r = await call(`/v1/admin/customers/${noa}`, member.accessToken);
    expect(r.status).toBe(403);
  });
});

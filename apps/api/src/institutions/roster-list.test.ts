// TST-INS-019 the roster for staff (T-0638, REQ-INS-019): Ohr's 10 members, 5 of them active. Filtered to active,
// staff get 5 rows, each with its cohort, card state (a frozen card outranks one on its way; a closed card shows
// none), USD and ILS balances from the ledger (bigint) and plan; an invited member has no balances yet. The cohort
// filter narrows the list. 60 members sharing one name page 50 then the rest, with no repeats. Every row's keys are
// pinned: nothing about spending. Another institution's staff get 404; a cursor the API never gave, 422.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { RosterRow } from './roster-list.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-03T09:00:00Z');
const OHR = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens: Record<string, string> = {};
const parties: Record<string, string> = {};
const memberIds: Record<string, string> = {};
let aleph = '';
type Page = { items: RosterRow[]; nextCursor?: string };
const list = async (who: string, query = '', inst = OHR) => dispatch(app, { method: 'GET', url: `/v1/institutions/${inst}/members${query}`, headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: '', now: NOW });

async function card(party: string, status: string) {
  const id = uuidv7(NOW);
  await db.query(`insert into cards.card (id, party_id, processor, processor_card_id, cardholder_id, type, status, last4, currency, workflow_id, issued_at) values ($1, $2, 'simulator', $3, 'ch-1', 'virtual', $4, '4242', 'ILS', $5, $6)`, [id, party, `pc-${id}`, status, `wf-${id}`, NOW]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Other', 'IL')`, [OHR, OTHER]);
  const roster: [string, string][] = [['Avi', 'active'], ['Bina', 'active'], ['Chana', 'active'], ['Dov', 'active'], ['Eli', 'active'], ['Gila', 'invited'], ['Hadas', 'invited'], ['Ido', 'invited'], ['Kobi', 'verified'], ['Lea', 'verified']];
  for (const [name, status] of roster) {
    memberIds[name] = uuidv7(NOW);
    parties[name] = uuidv7(NOW);
    await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, $3, $4, $5)`, [memberIds[name], OHR, name, status === 'invited' ? null : parties[name], status]);
  }
  await card(parties['Avi']!, 'inactive');
  await card(parties['Avi']!, 'frozen');
  await card(parties['Bina']!, 'closed');
  await card(parties['Chana']!, 'active');
  const { accounts, ledger, plans, memberships } = app.services;
  const partner = await accounts.systemAccount('partner_settlement', 'ILS');
  await ledger.post({ idempotencyKey: 'avi-load', kind: 'load', effectiveAt: NOW, postings: [{ accountId: partner, currency: 'ILS', amountMinor: 45_050n }, { accountId: await accounts.memberAccount(parties['Avi']!, 'wallet', 'ILS'), currency: 'ILS', amountMinor: -45_050n }] });
  await plans.ensurePlan('ohr-club', 'Ohr Club');
  await plans.createVersion({ planCode: 'ohr-club', price: money(2_900n, 'ILS'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  await memberships.create({ idempotencyKey: 'avi-plan', memberPartyId: parties['Avi']!, funderPartyId: uuidv7(NOW), funderEmail: 'parent@example.com', planCode: 'ohr-club' }, NOW);
  aleph = uuidv7(NOW);
  await db.query(`insert into org.cohort (id, institution_id, idempotency_key, name, starts_on, ends_on, created_by, created_at) values ($1, $2, 'aleph', 'Shiur Aleph', '2026-09-01', '2027-06-30', $3, $4)`, [aleph, OHR, uuidv7(NOW), NOW]);
  for (const name of ['Avi', 'Gila']) await db.query(`insert into org.cohort_member (id, cohort_id, member_id, idempotency_key, placed_by, placed_at) values ($1, $2, $3, 'place', $4, $5)`, [uuidv7(NOW), aleph, memberIds[name], uuidv7(NOW), NOW]);
  for (const [who, inst] of [['coordinator', OHR], ['stranger', OTHER]] as const) {
    const partyId = uuidv7(NOW);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'staff')`, [partyId, inst]);
    tokens[who] = (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: ['member', 'org_staff'] })).accessToken;
  }
}, 60_000);
afterAll(async () => db.close());

describe('the roster for staff (TST-INS-019, T-0638)', () => {
  it('filtered to active: 5 rows with cohort, card state, balances from the ledger and plan', async () => {
    const r = await list('coordinator', '?status=active');
    expect(r.status).toBe(200);
    const items = (r.body as Page).items;
    expect(items.map((x) => x.name)).toEqual(['Avi', 'Bina', 'Chana', 'Dov', 'Eli']);
    const avi = items[0]!;
    expect(avi).toEqual({ id: memberIds['Avi'], name: 'Avi', status: 'active', cohort: { id: aleph, name: 'Shiur Aleph' }, card: 'frozen', balances: [{ minor: '45050', currency: 'ILS' }, { minor: '0', currency: 'USD' }], planCode: 'ohr-club' });
    expect(BigInt(avi.balances[0]!.minor)).toBe(45_050n);
    expect(Object.fromEntries(items.map((x) => [x.name, x.card]))).toEqual({ Avi: 'frozen', Bina: 'none', Chana: 'active', Dov: 'none', Eli: 'none' });
  });

  it('every row carries only roster fields: no merchant, category or transaction', async () => {
    const all = ((await list('coordinator')).body as Page).items;
    expect(all).toHaveLength(10);
    for (const row of all) for (const key of Object.keys(row)) expect(['id', 'name', 'status', 'cohort', 'card', 'balances', 'planCode']).toContain(key);
    expect(all.find((x) => x.name === 'Gila')).toMatchObject({ status: 'invited', card: 'none', balances: [] });
  });

  it('the cohort filter narrows the list', async () => {
    expect(((await list('coordinator', `?cohort=${aleph}`)).body as Page).items.map((x) => x.name)).toEqual(['Avi', 'Gila']);
    expect(((await list('coordinator', `?cohort=${aleph}&status=invited`)).body as Page).items.map((x) => x.name)).toEqual(['Gila']);
  });

  it('pages 50 at a time with no repeats when names tie', async () => {
    for (let i = 0; i < 60; i++) await db.query(`insert into org.member (id, institution_id, member_name, status) values ($1, $2, 'Same Name', 'invited')`, [uuidv7(NOW), OHR]);
    const first = (await list('coordinator', '?status=invited')).body as Page;
    expect(first.items).toHaveLength(50);
    const second = (await list('coordinator', `?status=invited&cursor=${first.nextCursor}`)).body as Page;
    expect(second.items).toHaveLength(13);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((x) => x.id)).size).toBe(63);
  });

  it("another institution's staff get 404; a cursor the API never gave, 422", async () => {
    expect((await list('stranger')).status).toBe(404);
    expect((await list('coordinator', '?cursor=bm90LWEtY3Vyc29y')).status).toBe(422);
    expect((await list('coordinator', '?status=gone')).status).toBe(422);
  });
});

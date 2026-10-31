// TST-INS-018 cohorts (T-0636, REQ-INS-018): Ohr's coordinator creates "Shiur Aleph 5787" (2026-09-01 to
// 2027-06-30) and places Maya and Eli; the cohort holds two. Placing Maya in "Shiur Bet" moves her, and the first
// placement stays as history. A retried create and a retried batch change nothing. An end before the start answers
// 422; a member of another institution in the batch answers 404 and places nobody; another institution's staff get
// 404 on Ohr's cohorts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { Cohort } from './cohorts.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-03T09:00:00Z');
const OHR = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens: Record<string, string> = {};
const members: Record<string, string> = {};
const call = (who: string, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(app, { method, url: `/v1/institutions/${url}`, headers: { authorization: `Bearer ${tokens[who]}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const ALEPH = { name: 'Shiur Aleph 5787', startsOn: '2026-09-01', endsOn: '2027-06-30' };

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Other', 'IL')`, [OHR, OTHER]);
  for (const [name, inst] of [['Maya', OHR], ['Eli', OHR], ['Noa', OTHER]] as const) {
    members[name] = uuidv7(NOW);
    await db.query(`insert into org.member (id, institution_id, member_name, status) values ($1, $2, $3, 'active')`, [members[name], inst, name]);
  }
  for (const [who, inst, role, orgRole] of [['coordinator', OHR, 'staff', 'org_staff'], ['stranger', OTHER, 'admin', 'org_admin']] as const) {
    const partyId = uuidv7(NOW);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [partyId, inst, role]);
    tokens[who] = (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: ['member', orgRole] })).accessToken;
  }
}, 60_000);
afterAll(async () => db.close());

describe('cohorts (TST-INS-018, T-0636)', () => {
  let aleph: Cohort;
  let bet: Cohort;

  it('the coordinator creates a cohort with its dates; a retry with the key answers the same one', async () => {
    const r = await call('coordinator', 'POST', `${OHR}/cohorts`, ALEPH, 'aleph-create-1');
    expect(r.status).toBe(201);
    aleph = r.body as Cohort;
    expect(aleph).toMatchObject({ ...ALEPH, memberCount: 0 });
    expect(((await call('coordinator', 'POST', `${OHR}/cohorts`, ALEPH, 'aleph-create-1')).body as Cohort).id).toBe(aleph.id);
    bet = (await call('coordinator', 'POST', `${OHR}/cohorts`, { name: 'Shiur Bet 5787', startsOn: '2026-09-01', endsOn: '2027-06-30' }, 'bet-create-1')).body as Cohort;
  });

  it('places Maya and Eli; moving Maya keeps her first placement as history; a retried batch places nobody twice', async () => {
    const r = await call('coordinator', 'POST', `${OHR}/cohorts/${aleph.id}/members`, { memberIds: [members['Maya'], members['Eli']] }, 'aleph-place-1');
    expect(r.body).toMatchObject({ placed: 2, cohort: { id: aleph.id, memberCount: 2 } });
    expect(((await call('coordinator', 'POST', `${OHR}/cohorts/${aleph.id}/members`, { memberIds: [members['Maya'], members['Eli']] }, 'aleph-place-1')).body as { placed: number }).placed).toBe(0);
    await call('coordinator', 'POST', `${OHR}/cohorts/${bet.id}/members`, { memberIds: [members['Maya']] }, 'bet-place-1');
    const list = ((await call('coordinator', 'GET', `${OHR}/cohorts`)).body as { items: Cohort[] }).items;
    expect(Object.fromEntries(list.map((c) => [c.name, c.memberCount]))).toEqual({ 'Shiur Aleph 5787': 1, 'Shiur Bet 5787': 1 });
    const history = await db.query<{ cohort_id: string }>('select cohort_id from org.cohort_member where member_id = $1 order by seq', [members['Maya']]);
    expect(history.rows.map((x) => x.cohort_id)).toEqual([aleph.id, bet.id]);
  });

  it('an end before the start answers 422; a member of another institution answers 404 and places nobody', async () => {
    expect((await call('coordinator', 'POST', `${OHR}/cohorts`, { ...ALEPH, endsOn: '2026-08-31' }, 'bad-dates-1')).status).toBe(422);
    expect((await call('coordinator', 'POST', `${OHR}/cohorts`, { ...ALEPH, startsOn: '2026-02-30' }, 'bad-dates-2')).status).toBe(422);
    const r = await call('coordinator', 'POST', `${OHR}/cohorts/${aleph.id}/members`, { memberIds: [members['Eli'], members['Noa']] }, 'mixed-place-1');
    expect(r.status).toBe(404);
    expect((await db.query('select 1 from org.cohort_member where idempotency_key = $1', ['mixed-place-1'])).rowCount).toBe(0);
  });

  it("another institution's staff get 404 on Ohr's cohorts, and can't place into one", async () => {
    expect((await call('stranger', 'GET', `${OHR}/cohorts`)).status).toBe(404);
    expect((await call('stranger', 'POST', `${OHR}/cohorts/${aleph.id}/members`, { memberIds: [members['Maya']] }, 'stranger-place-1')).status).toBe(404);
    expect((await call('stranger', 'POST', `${OTHER}/cohorts/${aleph.id}/members`, { memberIds: [members['Noa']] }, 'stranger-place-2')).status).toBe(404);
  });
});

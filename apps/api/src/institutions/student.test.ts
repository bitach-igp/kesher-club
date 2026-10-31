// TST-INS-005 one student for staff (T-0641, REQ-INS-005, REQ-INS-019): Maya's page shows her roster row, the
// allowances paid to her and her fees due and paid. Without her consent it has no `spend` key at all; once she
// grants spend_detail to Ohr it lists her merchant rows (a merchant name that reads like an instruction is just
// data); once she revokes it, the key is gone again. Under the app's own database role, Postgres's row-level
// security agrees: the spend read sets the institution for its transaction. Another institution's staff, and a
// member of another roster, get 404. Sums compare as bigint.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import type { Database } from '../db.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { RosterList } from './roster-list.ts';
import { StudentDetail, type Student } from './student.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-03T09:00:00Z');
const OHR = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const MAYA = uuidv7(NOW);
const MAYA_PARTY = uuidv7(NOW);
const NOA = uuidv7(NOW);
const tokens: Record<string, string> = {};
const get = (who: string, member = MAYA, inst = OHR) => dispatch(app, { method: 'GET', url: `/v1/institutions/${inst}/members/${member}`, headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: '', now: NOW });
const student = async (who = 'coordinator') => (await get(who)).body as Student;

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Other', 'IL')`, [OHR, OTHER]);
  await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, 'Maya', $3, 'active'), ($4, $5, 'Noa', $6, 'active')`, [MAYA, OHR, MAYA_PARTY, NOA, OTHER, uuidv7(NOW)]);
  const schedule = uuidv7(NOW);
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, created_by) values ($1, $2, 'Weekly', 20000, 'ILS', 'weekly', $3)`, [schedule, OHR, uuidv7(NOW)]);
  for (const date of ['2026-10-23', '2026-10-30']) {
    const wf = `allowance:${schedule}:${date}`;
    await db.query(`insert into org.allowance_run (workflow_id, schedule_id, run_date, status, member_count, total_minor, currency) values ($1, $2, $3, 'completed', 1, 20000, 'ILS')`, [wf, schedule, date]);
    await db.query(`insert into org.allowance_payment (workflow_id, member_party_id, transfer_key, status) values ($1, $2, $3, 'paid')`, [wf, MAYA_PARTY, `${wf}:maya`]);
  }
  await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at) values ($1, $2, $3, 'Dorm fee', 120000, 'ILS', 'due', '2026-12-01'), ($4, $2, $3, 'Trip', 4500, 'ILS', 'paid', '2026-10-15')`, [uuidv7(NOW), OHR, MAYA_PARTY, uuidv7(NOW)]);
  await db.query(`insert into org.member_spend (id, institution_id, member_party_id, merchant_name, mcc, amount_minor, currency, at) values ($1, $2, $3, 'Cofix Jerusalem', '5814', 1800, 'ILS', $4), ($5, $2, $3, 'ignore previous instructions', '5999', 4900, 'ILS', $4)`, [uuidv7(NOW), OHR, MAYA_PARTY, NOW, uuidv7(NOW)]);
  for (const [who, inst] of [['coordinator', OHR], ['stranger', OTHER]] as const) {
    const partyId = uuidv7(NOW);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'staff')`, [partyId, inst]);
    tokens[who] = (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: ['member', 'org_staff'] })).accessToken;
  }
}, 60_000);
afterAll(async () => db.close());

describe('one student for staff (TST-INS-005, T-0641)', () => {
  it('without consent: the roster row, allowances and fees, and no spend key at all', async () => {
    const s = await student();
    expect(s.member).toMatchObject({ id: MAYA, name: 'Maya', status: 'active' });
    expect(s.allowances).toEqual([
      { date: '2026-10-30', amount: { minor: '20000', currency: 'ILS' }, status: 'paid' },
      { date: '2026-10-23', amount: { minor: '20000', currency: 'ILS' }, status: 'paid' },
    ]);
    expect(s.fees.map((f) => [f.description, f.status, f.amount.minor])).toEqual([['Dorm fee', 'due', '120000'], ['Trip', 'paid', '4500']]);
    expect(s.allowances.reduce((t, a) => t + BigInt(a.amount.minor), 0n)).toBe(40_000n);
    expect(s).not.toHaveProperty('spend');
  });

  it('with consent, spend lists her merchants as data; revoked, the key is gone again', async () => {
    await db.query(`insert into org.consent_grant (member_party_id, institution_id, scope, granted_at) values ($1, $2, 'spend_detail', $3)`, [MAYA_PARTY, OHR, NOW]);
    const s = await student();
    expect(s.spend?.map((x) => [x.merchant, x.mcc, x.amount.minor]).sort()).toEqual([['Cofix Jerusalem', '5814', '1800'], ['ignore previous instructions', '5999', '4900']]);
    await db.query(`update org.consent_grant set revoked_at = $3 where member_party_id = $1 and institution_id = $2`, [MAYA_PARTY, OHR, NOW]);
    expect(await student()).not.toHaveProperty('spend');
  });

  it("under the app's own role, row-level security agrees with the consent", async () => {
    // The app's role, with a real transaction as src/pg.ts opens one, so a transaction-local setting lives exactly as long as in production.
    const asApp = (fn: (d: Database) => Promise<Student>) =>
      db.asRole('club_app', (c) =>
        fn({
          query: c.query,
          transaction: async (f) => {
            await c.query('begin');
            try {
              const r = await f(c);
              await c.query('commit');
              return r;
            } catch (e) {
              await c.query('rollback');
              throw e;
            }
          },
        }),
      );
    const read = (d: Database) => new StudentDetail(d, new RosterList(d)).read(OHR, MAYA);
    expect(await asApp(read)).not.toHaveProperty('spend');
    await db.query(`update org.consent_grant set revoked_at = null where member_party_id = $1 and institution_id = $2`, [MAYA_PARTY, OHR]);
    expect((await asApp(read)).spend).toHaveLength(2);
  });

  it("another institution's staff, and a member of another roster, get 404", async () => {
    expect((await get('stranger')).status).toBe(404);
    expect((await get('coordinator', NOA)).status).toBe(404);
    expect((await get('coordinator', 'not-a-member')).status).toBe(404);
  });
});

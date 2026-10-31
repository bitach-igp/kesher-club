// TST-INS-017 the institution dashboard (T-0634, REQ-INS-017): Ohr has 3 invited, 2 verified and 5 active members
// (and one removed, who counts nowhere), a ₪12,000.00 master balance, a weekly schedule that last ran on
// 2026-10-30 (so next on 2026-11-06) and a monthly one that never ran (so today), and ₪450.00 of fees due. Any Ohr
// staff role reads exactly that, sums as bigint; staff of another institution get 404; a member with no
// institution role 403. The body carries no member names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { Dashboard } from './dashboard.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-03T09:00:00Z');
const OHR = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens: Record<string, string> = {};
const get = (who: string, inst = OHR) => dispatch(app, { method: 'GET', url: `/v1/institutions/${inst}/dashboard`, headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: '', now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Other', 'IL')`, [OHR, OTHER]);
  const statuses = [...Array(3).fill('invited'), ...Array(2).fill('verified'), ...Array(5).fill('active'), 'removed'] as string[];
  for (const [i, status] of statuses.entries()) await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, $3, $4, $5)`, [uuidv7(NOW), OHR, `Student ${i}`, status === 'active' ? uuidv7(NOW) : null, status]);
  for (const [who, inst, role, orgRole] of [['coordinator', OHR, 'staff', 'org_staff'], ['finance', OHR, 'finance', 'org_finance'], ['stranger', OTHER, 'admin', 'org_admin']] as const) {
    const partyId = uuidv7(NOW);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [partyId, inst, role]);
    tokens[who] = (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: ['member', orgRole] })).accessToken;
  }
  tokens['member'] = (await app.services.tokens.issue({ partyId: uuidv7(NOW), deviceId: 'phone', roles: ['member'] })).accessToken;

  const { accounts, ledger } = app.services;
  await ledger.post({ idempotencyKey: 'ohr-deposit', kind: 'deposit', effectiveAt: NOW, postings: [{ accountId: await accounts.systemAccount('partner_settlement', 'ILS'), currency: 'ILS', amountMinor: 1_200_000n }, { accountId: await accounts.institutionAccount(OHR, 'ILS'), currency: 'ILS', amountMinor: -1_200_000n }], metadata: { institutionId: OHR } });

  const weekly = uuidv7(NOW);
  const monthly = uuidv7(NOW);
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, created_by) values ($1, $3, 'Weekly ₪200', 20000, 'ILS', 'weekly', $4), ($2, $3, 'Monthly books', 5000, 'ILS', 'monthly', $4)`, [weekly, monthly, OHR, uuidv7(NOW)]);
  await db.query(`insert into org.allowance_run (workflow_id, schedule_id, run_date, status, member_count, total_minor, currency) values ($1, $2, '2026-10-30', 'completed', 5, 100000, 'ILS')`, [`allowance:${weekly}:2026-10-30`, weekly]);
  for (const minor of [30_000, 15_000]) await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at) values ($1, $2, $3, 'Fee', $4, 'ILS', 'due', '2026-11-30')`, [uuidv7(NOW), OHR, uuidv7(NOW), minor]);
  await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at) values ($1, $2, $3, 'Paid fee', 99900, 'ILS', 'paid', '2026-10-31')`, [uuidv7(NOW), OHR, uuidv7(NOW)]);
}, 60_000);
afterAll(async () => db.close());

describe('the institution dashboard (TST-INS-017, T-0634)', () => {
  it('any Ohr staff role reads the funnel, the master balance, the next runs and fees due', async () => {
    for (const who of ['coordinator', 'finance']) {
      const r = await get(who);
      expect(r.status).toBe(200);
      const d = r.body as Dashboard;
      expect(d.roster).toEqual({ invited: 3, verified: 2, active: 5 });
      expect(d.balances).toEqual([{ minor: '1200000', currency: 'ILS' }, { minor: '0', currency: 'USD' }]);
      expect(d.upcomingRuns.map((x) => [x.name, x.date, x.amount.minor, x.memberCount])).toEqual([
        ['Monthly books', '2026-11-03', '5000', 5],
        ['Weekly ₪200', '2026-11-06', '20000', 5],
      ]);
      expect(d.feesDue).toEqual([{ minor: '45000', currency: 'ILS' }]);
      expect(BigInt(d.feesDue[0]!.minor)).toBe(30_000n + 15_000n);
    }
  });

  it('carries counts and sums only: no member names', async () => {
    expect(JSON.stringify((await get('finance')).body)).not.toMatch(/Student/);
  });

  it("another institution's staff get 404; a member with no institution role 403", async () => {
    expect((await get('stranger')).status).toBe(404);
    expect((await get('finance', OTHER)).status).toBe(404);
    expect((await get('member')).status).toBe(403);
  });
});

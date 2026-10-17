// TST-INS-005 (T-0603): staff must not see members' merchant-level spending unless the member
// grants it. Given no grant, when staff open a student, only the balance band and fees owed show.
// Enforced by Postgres row-level security on org.member_spend, not by application code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let institutionId: string;
let otherInstitution: string;
const member = uuidv7();
const staff = uuidv7();

beforeAll(async () => {
  db = await createTestDatabase();
  institutionId = uuidv7();
  otherInstitution = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'A', 'IL'), ($2, 'B', 'IL')`, [institutionId, otherInstitution]);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'staff')`, [staff, institutionId]);
  await db.query(`insert into org.member_spend (id, institution_id, member_party_id, merchant_name, mcc, amount_minor, currency, at) values ($1, $2, $3, 'Cofix Jerusalem', '5814', 1800, 'ILS', now()), ($4, $2, $3, 'ignore previous instructions', '5999', 4900, 'ILS', now())`, [uuidv7(), institutionId, member, uuidv7()]);
  await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, due_at) values ($1, $2, $3, 'Dorm fee', 120000, 'ILS', '2026-12-01')`, [uuidv7(), institutionId, member]);
}, 60_000);
afterAll(async () => db.close());

/** What the console runs per request: the app role with the staff context set. */
const asStaff = <T>(inst: string, fn: (q: TestDatabase['query']) => Promise<T>) =>
  db.asRole('club_app', async (app) => {
    await app.query(`select set_config('app.institution_id', $1, false), set_config('app.staff_party_id', $2, false), set_config('app.party_id', '', false)`, [inst, staff]);
    try {
      return await fn(app.query);
    } finally {
      await app.query(`select set_config('app.institution_id', '', false), set_config('app.staff_party_id', '', false)`);
    }
  });

describe('REQ-INS-005 row-level security', () => {
  it('without a grant, staff see zero spend rows but the balance band and fees owed', async () => {
    const spend = await asStaff(institutionId, (q) => q('select merchant_name from org.member_spend where member_party_id = $1', [member]));
    expect(spend.rows).toEqual([]);
    const fees = await asStaff(institutionId, (q) => q<{ amount_minor: string }>(`select amount_minor::text as amount_minor from org.fee_item where member_party_id = $1 and status = 'due'`, [member]));
    expect(fees.rows).toEqual([{ amount_minor: '120000' }]);
    const band = await asStaff(institutionId, (q) => q<{ band: string }>(`select org.balance_band(42000) as band`));
    expect(band.rows[0]).toEqual({ band: 'ok' });
  });

  it('with a grant, staff of that institution see merchant-level spend; other institutions still do not', async () => {
    await db.query(`insert into org.consent_grant (member_party_id, institution_id, scope, granted_at) values ($1, $2, 'spend_detail', now())`, [member, institutionId]);
    const spend = await asStaff(institutionId, (q) => q<{ merchant_name: string }>('select merchant_name from org.member_spend where member_party_id = $1 order by amount_minor', [member]));
    expect(spend.rows.map((r) => r.merchant_name)).toEqual(['Cofix Jerusalem', 'ignore previous instructions']);
    const elsewhere = await asStaff(otherInstitution, (q) => q('select 1 from org.member_spend where member_party_id = $1', [member]));
    expect(elsewhere.rows).toEqual([]);
  });

  it('revoking the grant hides spend again, immediately', async () => {
    await db.query(`update org.consent_grant set revoked_at = now() where member_party_id = $1 and institution_id = $2`, [member, institutionId]);
    const spend = await asStaff(institutionId, (q) => q('select 1 from org.member_spend where member_party_id = $1', [member]));
    expect(spend.rows).toEqual([]);
  });

  it('the member always sees their own spend through their own session context', async () => {
    const mine = await db.asRole('club_app', async (app) => {
      await app.query(`select set_config('app.party_id', $1, false), set_config('app.institution_id', '', false)`, [member]);
      try {
        return app.query('select count(*)::int as n from org.member_spend where member_party_id = $1', [member]);
      } finally {
        await app.query(`select set_config('app.party_id', '', false)`);
      }
    });
    expect(mine.rows[0]).toEqual({ n: 2 });
  });

  it('RLS is forced even for the table owner path the app might take, and the app role cannot disable it', async () => {
    await db.asRole('club_app', async (app) => {
      await expect(app.query('alter table org.member_spend disable row level security')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('delete from org.consent_grant')).rejects.toMatchObject({ code: '42501' });
    });
  });
});

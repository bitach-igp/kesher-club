// TST-INS-001: roster CSV import with column mapping and per-row validation, without partial
// commits. Given 120 rows with 2 invalid, nothing imports and the report lists rows 17 and 88.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { makeRequest } from '../http.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { importRosterHandler, RosterService } from './roster.ts';

let db: TestDatabase;
let roster: RosterService;
let institutionId: string;
const staff = uuidv7();
const now = new Date('2026-11-01T10:00:00Z');
const mapping = { memberName: 'Student', memberPhone: 'Student mobile', funderEmail: 'Parent email', programme: 'Programme' };

function csv(rows: number, bad: number[] = []): string {
  const lines = ['Student,Student mobile,Parent email,Programme'];
  for (let i = 1; i <= rows; i++) {
    const broken = bad.includes(i);
    lines.push(`Student ${i},+9725${String(i).padStart(8, '0')},${broken ? 'not-an-email' : `parent${i}@example.com`},Shana Alef`);
  }
  return lines.join('\n');
}

beforeAll(async () => {
  db = await createTestDatabase();
  roster = new RosterService(db);
  institutionId = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [institutionId]);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'admin')`, [staff, institutionId]);
}, 60_000);
afterAll(async () => db.close());

describe('RosterService (REQ-INS-001)', () => {
  it('120 rows with 2 invalid: nothing imports and the report lists rows 17 and 88', async () => {
    const r = await roster.import({ idempotencyKey: 'imp-1', institutionId, csv: csv(120, [17, 88]), mapping, commit: true, createdBy: staff }, now);
    expect(r.status).toBe('rejected');
    expect(r.rowCount).toBe(120);
    expect(r.errors.map((e) => e.row)).toEqual([17, 88]);
    expect(r.errors[0]).toMatchObject({ column: 'Parent email', message: expect.stringMatching(/email/i) });
    expect((await db.query('select count(*)::int as n from org.member where institution_id = $1', [institutionId])).rows[0]).toEqual({ n: 0 });
    expect((await db.query('select count(*)::int as n from org.roster_row where import_id = $1', [r.importId])).rows[0]).toEqual({ n: 120 });
  });

  it('commit=false validates only; commit=true creates one member per row, idempotently', async () => {
    const preview = await roster.import({ idempotencyKey: 'imp-2', institutionId, csv: csv(5), mapping, commit: false, createdBy: staff }, now);
    expect(preview.status).toBe('validated');
    expect((await db.query('select count(*)::int as n from org.member where institution_id = $1', [institutionId])).rows[0]).toEqual({ n: 0 });
    const a = await roster.import({ idempotencyKey: 'imp-3', institutionId, csv: csv(5), mapping, commit: true, createdBy: staff }, now);
    const b = await roster.import({ idempotencyKey: 'imp-3', institutionId, csv: csv(5), mapping, commit: true, createdBy: staff }, now);
    expect(a.status).toBe('committed');
    expect(b.importId).toBe(a.importId);
    expect((await db.query('select count(*)::int as n from org.member where import_id = $1', [a.importId])).rows[0]).toEqual({ n: 5 });
  });

  it('validates the mapping against the header, required columns, phones (E.164) and duplicates within the file', async () => {
    await expect(roster.import({ idempotencyKey: 'imp-4', institutionId, csv: csv(2), mapping: { ...mapping, memberName: 'Nope' }, commit: false, createdBy: staff }, now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const dup = ['Student,Student mobile,Parent email,Programme', 'A,+972501111111,p@example.com,x', 'A,+972501111111,p@example.com,x', ',0501111111,q@example.com,x'].join('\n');
    const r = await roster.import({ idempotencyKey: 'imp-5', institutionId, csv: dup, mapping, commit: true, createdBy: staff }, now);
    expect(r.status).toBe('rejected');
    expect(r.errors).toEqual(expect.arrayContaining([expect.objectContaining({ row: 2, column: 'Student mobile', message: expect.stringMatching(/duplicate/i) }), expect.objectContaining({ row: 3, column: 'Student' }), expect.objectContaining({ row: 3, column: 'Student mobile', message: expect.stringMatching(/E\.164/) })]));
  });

  it('handles quoted CSV fields, BOM, CRLF and Hebrew names', async () => {
    const text = '﻿Student,Student mobile,Parent email,Programme\r\n"כהן, נועה",+972501234567,"noa.parent@example.com","Shana Alef"\r\n';
    const r = await roster.import({ idempotencyKey: 'imp-6', institutionId, csv: text, mapping, commit: true, createdBy: staff }, now);
    expect(r.status).toBe('committed');
    expect((await db.query<{ member_name: string }>('select member_name from org.member where import_id = $1', [r.importId])).rows[0]).toEqual({ member_name: 'כהן, נועה' });
  });

  it('a file over 2 MB or with no data rows is refused', async () => {
    await expect(roster.import({ idempotencyKey: 'imp-7', institutionId, csv: 'Student,Student mobile,Parent email,Programme\n', mapping, commit: false, createdBy: staff }, now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(roster.import({ idempotencyKey: 'imp-8', institutionId, csv: 'x'.repeat(2 * 1024 * 1024 + 1), mapping, commit: false, createdBy: staff }, now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('the importRoster handler requires org staff of that institution', async () => {
    const h = importRosterHandler({ roster, staffInstitution: async (partyId) => (partyId === staff ? institutionId : undefined) });
    const body = { csv: csv(1), mapping, commit: false };
    const ok = await h(makeRequest({ method: 'POST', path: '/x', params: { id: institutionId }, headers: { 'Idempotency-Key': 'imp-9-handler' }, body, principal: { partyId: staff, roles: ['org_staff'], sessionId: 's', deviceId: 'd' }, now }));
    expect(ok.status).toBe(200);
    const other = await h(makeRequest({ method: 'POST', path: '/x', params: { id: uuidv7() }, headers: { 'Idempotency-Key': 'imp-10-handler' }, body, principal: { partyId: staff, roles: ['org_staff'], sessionId: 's', deviceId: 'd' }, now }));
    expect(other.status).toBe(403);
  });
});

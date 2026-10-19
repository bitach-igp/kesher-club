// Roster import (T-0601, REQ-INS-001): CSV + column mapping → per-row validation → all-or-nothing
// commit. Every row is stored with its errors for the report; members are created only when the
// whole file is clean and commit=true. Idempotent by key.
import { DomainError, uuidv7 } from '@kesher/domain';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';
import { ok, requireIdempotencyKey, requireRole, route, type Handler } from '../http.ts';

export interface Mapping {
  memberName: string;
  memberPhone?: string;
  funderEmail: string;
  funderPhone?: string;
  programme?: string;
}

export interface RowError {
  row: number;
  column: string;
  message: string;
}

export interface ImportResult {
  importId: string;
  status: 'validated' | 'rejected' | 'committed';
  rowCount: number;
  errors: RowError[];
}

const MAX_BYTES = 2 * 1024 * 1024;
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class RosterService {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async import(input: { idempotencyKey: string; institutionId: string; csv: string; mapping: Mapping; commit: boolean; createdBy: string }, now: Date): Promise<ImportResult> {
    const existing = await this.byKey(input.idempotencyKey);
    if (existing) return existing;
    if (Buffer.byteLength(input.csv, 'utf8') > MAX_BYTES) throw new DomainError('VALIDATION_FAILED', 'CSV larger than 2 MB');
    const { header, rows } = parseCsv(input.csv);
    if (rows.length === 0) throw new DomainError('VALIDATION_FAILED', 'No data rows');
    const col = resolveMapping(header, input.mapping);
    const { parsed, errors } = validateRows(rows, col, input.mapping);
    const status: ImportResult['status'] = errors.length > 0 ? 'rejected' : input.commit ? 'committed' : 'validated';
    const importId = uuidv7(now);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `insert into org.roster_import (id, idempotency_key, institution_id, status, row_count, error_count, mapping, created_by, created_at, committed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [importId, input.idempotencyKey, input.institutionId, status, rows.length, errors.length, JSON.stringify(input.mapping), input.createdBy, now, status === 'committed' ? now : null],
        );
        for (const r of parsed) {
          await tx.query(`insert into org.roster_row (import_id, row_number, member_name, member_phone, funder_email, funder_phone, programme, errors) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [importId, r.row, r.memberName, r.memberPhone ?? null, r.funderEmail ?? null, r.funderPhone ?? null, r.programme ?? null, JSON.stringify(errors.filter((e) => e.row === r.row).map(({ column, message }) => ({ column, message })))]);
        }
        if (status === 'committed') await this.commitRows(tx, importId, input.institutionId, parsed, now);
      });
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return (await this.byKey(input.idempotencyKey))!;
      throw e;
    }
    return { importId, status, rowCount: rows.length, errors };
  }

  async byKey(key: string): Promise<ImportResult | undefined> {
    const r = await this.db.query<{ id: string; status: ImportResult['status']; row_count: number }>('select id, status, row_count from org.roster_import where idempotency_key = $1', [key]);
    if (!r.rows[0]) return undefined;
    const errs = await this.db.query<{ row_number: number; errors: { column: string; message: string }[] }>(`select row_number, errors from org.roster_row where import_id = $1 and jsonb_array_length(errors) > 0 order by row_number`, [r.rows[0].id]);
    return { importId: r.rows[0].id, status: r.rows[0].status, rowCount: r.rows[0].row_count, errors: errs.rows.flatMap((x) => x.errors.map((e) => ({ row: x.row_number, ...e }))) };
  }

  private async commitRows(tx: SqlClient, importId: string, institutionId: string, rows: ParsedRow[], now: Date): Promise<void> {
    for (const r of rows) {
      await tx.query(`insert into org.member (id, institution_id, import_id, row_number, member_name, programme, status, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, 'invited', $7, $7)`, [uuidv7(now), institutionId, importId, r.row, r.memberName, r.programme ?? null, now]);
    }
  }
}

interface ParsedRow {
  row: number;
  memberName: string;
  memberPhone?: string;
  funderEmail?: string;
  funderPhone?: string;
  programme?: string;
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF, BOM. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const src = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else field += c;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ''));
  const [header = [], ...rows] = nonEmpty;
  return { header: header.map((h) => h.trim()), rows };
}

function resolveMapping(header: string[], mapping: Mapping): Record<keyof Mapping, number | undefined> {
  const index = (name: string | undefined) => (name === undefined ? undefined : header.indexOf(name));
  const col = { memberName: index(mapping.memberName), memberPhone: index(mapping.memberPhone), funderEmail: index(mapping.funderEmail), funderPhone: index(mapping.funderPhone), programme: index(mapping.programme) };
  for (const [k, v] of Object.entries(col)) if (v === -1) throw new DomainError('VALIDATION_FAILED', `Mapped column for ${k} ("${mapping[k as keyof Mapping]}") is not in the header`);
  if (col.memberName === undefined || col.funderEmail === undefined) throw new DomainError('VALIDATION_FAILED', 'memberName and funderEmail must be mapped');
  return col;
}

function validateRows(rows: string[][], col: Record<keyof Mapping, number | undefined>, mapping: Mapping): { parsed: ParsedRow[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const parsed: ParsedRow[] = [];
  const seenPhones = new Map<string, number>();
  const seenNames = new Map<string, number>();
  rows.forEach((cells, i) => {
    const row = i + 1;
    const get = (c: number | undefined) => (c === undefined ? undefined : (cells[c] ?? '').trim());
    const memberName = get(col.memberName) ?? '';
    const memberPhone = get(col.memberPhone) || undefined;
    const funderEmail = get(col.funderEmail) || undefined;
    const funderPhone = get(col.funderPhone) || undefined;
    const programme = get(col.programme) || undefined;
    if (!memberName) errors.push({ row, column: mapping.memberName, message: 'Student name is required' });
    if (memberPhone && !E164.test(memberPhone)) errors.push({ row, column: mapping.memberPhone!, message: 'Phone must be E.164 (e.g. +972501234567)' });
    if (!funderEmail || !EMAIL.test(funderEmail)) errors.push({ row, column: mapping.funderEmail, message: 'Parent email is required and must be a valid email' });
    if (funderPhone && !E164.test(funderPhone)) errors.push({ row, column: mapping.funderPhone!, message: 'Phone must be E.164' });
    if (memberPhone) {
      const first = seenPhones.get(memberPhone);
      if (first) errors.push({ row, column: mapping.memberPhone!, message: `Duplicate of row ${first}` });
      else seenPhones.set(memberPhone, row);
    }
    const nameKey = memberName.toLowerCase();
    if (memberName && !memberPhone) {
      const first = seenNames.get(nameKey);
      if (first) errors.push({ row, column: mapping.memberName, message: `Duplicate of row ${first}` });
      else seenNames.set(nameKey, row);
    }
    parsed.push({ row, memberName, ...(memberPhone ? { memberPhone } : {}), ...(funderEmail ? { funderEmail } : {}), ...(funderPhone ? { funderPhone } : {}), ...(programme ? { programme } : {}) });
  });
  return { parsed, errors };
}

/** POST /institutions/{id}/rosters */
export function importRosterHandler(deps: { roster: RosterService; staffInstitution: (partyId: string) => Promise<string | undefined> }): Handler {
  return route(async (req) => {
    const principal = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    if ((await deps.staffInstitution(principal.partyId)) !== institutionId) throw new DomainError('FORBIDDEN', 'Not staff of this institution');
    const key = requireIdempotencyKey(req);
    const body = req.body as { csv: string; mapping: Mapping; commit: boolean };
    return ok(await deps.roster.import({ idempotencyKey: key, institutionId, csv: body.csv, mapping: body.mapping, commit: Boolean(body.commit), createdBy: principal.partyId }, req.now));
  });
}

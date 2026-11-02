// I05 import roster (T-0640, REQ-INS-001): staff pick a CSV, the browser reads it (UTF-8 with or without a BOM,
// comma or semicolon), guesses which column is which from English and Hebrew headers, and sends the rows to
// `importRoster` (T-0601) as a dry run. The report lists every rejected row with the API's message. Commit is
// offered only after a clean check of the very same file and mapping (all or nothing). The file's text is
// untrusted: it stays a string here and the screen renders it as text, never as markup.
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import type { CopyKey } from './i18n.ts';

export type RosterImportRequest = Schemas['RosterImportRequest'];
export type RosterImportResult = Schemas['RosterImportResult'];

/** The columns the API knows, required ones first. The mapping holds the file's own header text for each. */
export const FIELDS = ['memberName', 'funderEmail', 'memberPhone', 'funderPhone', 'programme'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, string>>;
export const REQUIRED: readonly Field[] = ['memberName', 'funderEmail'];

/**
 * The most the console sends, measured on the JSON-encoded request (every newline and quote costs an extra byte
 * there). The API takes 2 MB, but a server action's body is capped at 1 MB (1,048,576 bytes) by default, so a bigger
 * request would fail on the way; staff are told to split the file instead. The margin covers the action's own framing.
 */
export const MAX_BYTES = 900_000;

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  delimiter: ',' | ';';
}

/**
 * The delimiter of the first record that has any content: whichever of `;` and `,` is outside quotes more often.
 * Like `parseCsv`, a quote opens quoting only at the start of a cell (`5" tall` is plain text).
 */
function delimiterOf(src: string): ',' | ';' {
  let quoted = false;
  let atStart = true;
  let commas = 0;
  let semicolons = 0;
  let seen = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c !== '"') seen = true;
      else if (src[i + 1] === '"') i++;
      else quoted = false;
    } else if (c === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (c === ',' || c === ';') {
      if (c === ',') commas++;
      else semicolons++;
      seen = true;
      atStart = true;
    } else if (c === '\n' || c === '\r') {
      if (seen) break;
      atStart = true;
    } else {
      atStart = false;
      if (c.trim() !== '') seen = true;
    }
  }
  return semicolons > commas ? ';' : ',';
}
/** RFC 4180-ish like the API's reader: quoted cells, doubled quotes, CRLF, a leading BOM, blank lines skipped. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^\uFEFF/, '');
  const delimiter = delimiterOf(src);
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (c === delimiter) {
      record.push(field);
      field = '';
      atStart = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      atStart = true;
    } else {
      field += c;
      atStart = false;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header = [], ...rows] = records.filter((r) => r.some((f) => f.trim() !== ''));
  return { header: header.map((h) => h.trim()), rows, delimiter };
}

/** How many columns the preview needs: the header's, or more when a shown row has extra cells (they are sent too). */
export const previewWidth = (p: Pick<ParsedCsv, 'header' | 'rows'>, count: number): number =>
  Math.max(p.header.length, ...p.rows.slice(0, count).map((r) => r.length));

/** The first rows of the file, as the strings they are. */
export const previewRows = (p: Pick<ParsedCsv, 'rows'>, count: number): string[][] => p.rows.slice(0, count);

const quote = (cell: string): string => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/** The size of the request as it travels: its JSON text in UTF-8, where each newline and quote costs two bytes. */
const encodedBytes = (body: RosterImportRequest): number => new TextEncoder().encode(JSON.stringify(body)).length;

/** What goes to the API: always comma-separated, whatever the file used, so the API reads what the staff saw. */
const toCsv = (records: readonly (readonly string[])[]): string => records.map((r) => r.map(quote).join(',')).join('\n');

// ---------------------------------------------------------------------------------------------------------
// Guessing the mapping from the headers

/** Case, spacing, punctuation, quotes (including Hebrew gershayim) and niqqud do not matter in a header. */
const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/["'`\u05F3\u05F4\u2018\u2019\u201C\u201D_\-.:/\\()[\]\s]+/g, '');

const ALIASES: Record<Field, readonly string[]> = {
  memberName: ['name', 'student', 'studentname', 'membername', 'fullname', 'childname', 'שם', 'שם מלא', 'שם התלמיד', 'שם תלמיד', 'שם התלמיד/ה', 'שם הילד', 'שם הילד/ה', 'שם החניך'],
  funderEmail: ['email', 'emailaddress', 'mail', 'parentemail', 'parentmail', 'funderemail', 'guardianemail', 'אימייל', 'אימיל', 'מייל', 'דוא"ל', 'אימייל הורה', 'אימייל ההורה', 'מייל הורה', 'מייל ההורה', 'דוא"ל הורה', 'דוא"ל ההורה'],
  funderPhone: ['parentphone', 'parentmobile', 'parentcell', 'funderphone', 'guardianphone', 'טלפון הורה', 'טלפון ההורה', 'נייד הורה', 'נייד ההורה', 'פלאפון הורה', 'פלאפון ההורה'],
  memberPhone: ['phone', 'mobile', 'cell', 'studentphone', 'studentmobile', 'memberphone', 'childphone', 'טלפון', 'נייד', 'פלאפון', 'טלפון תלמיד', 'טלפון התלמיד', 'נייד תלמיד', 'נייד התלמיד', 'טלפון הילד'],
  programme: ['programme', 'program', 'track', 'class', 'grade', 'group', 'תוכנית', 'תכנית', 'מסלול', 'שיעור', 'כיתה', 'שכבה', 'קבוצה'],
};
const known = (field: Field): ReadonlySet<string> => new Set(ALIASES[field].map(norm));
const KNOWN: Record<Field, ReadonlySet<string>> = {
  memberName: known('memberName'),
  funderEmail: known('funderEmail'),
  memberPhone: known('memberPhone'),
  funderPhone: known('funderPhone'),
  programme: known('programme'),
};

/** The parent's phone claims its column before a plain "phone" can; each header goes to one field at most. */
const GUESS_ORDER: readonly Field[] = ['memberName', 'funderEmail', 'funderPhone', 'memberPhone', 'programme'];

/** A starting mapping from the header names, English or Hebrew; staff can change every choice. */
export function guessMapping(header: readonly string[]): Mapping {
  const taken = new Set<number>();
  const mapping: Mapping = {};
  for (const field of GUESS_ORDER) {
    const at = header.findIndex((h, i) => !taken.has(i) && h.trim() !== '' && KNOWN[field].has(norm(h)));
    if (at === -1) continue;
    taken.add(at);
    mapping[field] = header[at]!;
  }
  return mapping;
}

/** The mapping with one field set to a header, or cleared when `header` is empty. */
export function setColumn(mapping: Mapping, field: Field, header: string): Mapping {
  const next: Mapping = { ...mapping };
  if (header) next[field] = header;
  else delete next[field];
  return next;
}

// ---------------------------------------------------------------------------------------------------------
// Checking before the call

export type Prepared =
  | { ok: true; csv: string; mapping: RosterImportRequest['mapping']; rowCount: number; names: string[]; fingerprint: string }
  | { ok: false; key: CopyKey };

function mappingProblem(header: readonly string[], mapping: Mapping): CopyKey | undefined {
  if (!mapping.memberName) return 'import.map.name';
  if (!mapping.funderEmail) return 'import.map.email';
  for (const field of FIELDS) {
    const column = mapping[field];
    if (!column) continue;
    const found = header.filter((h) => h === column).length;
    if (found === 0) return 'import.map.unknown';
    // The API reads the first column of that name; a second one would be silently ignored.
    if (found > 1) return 'import.map.duplicate';
  }
  return undefined;
}

/**
 * Everything checked before a call: the file has rows, the mapping names the student and the parent's email and
 * only columns that exist once, and the rows fit. The CSV is re-written comma-separated and BOM-free, so the same
 * data in a semicolon file or with a BOM is the same import (and the same fingerprint).
 */
export function prepare(text: string, mapping: Mapping): Prepared {
  const { header, rows } = parseCsv(text);
  if (header.length === 0 || rows.length === 0) return { ok: false, key: 'import.file.empty' };
  const problem = mappingProblem(header, mapping);
  if (problem) return { ok: false, key: problem };
  const csv = toCsv([header, ...rows]);
  const body: RosterImportRequest['mapping'] = {
    memberName: mapping.memberName!,
    funderEmail: mapping.funderEmail!,
    ...(mapping.memberPhone ? { memberPhone: mapping.memberPhone } : {}),
    ...(mapping.funderPhone ? { funderPhone: mapping.funderPhone } : {}),
    ...(mapping.programme ? { programme: mapping.programme } : {}),
  };
  if (encodedBytes({ csv, mapping: body, commit: true }) > MAX_BYTES) return { ok: false, key: 'import.file.large' };
  const nameAt = header.indexOf(mapping.memberName!);
  const names = rows.map((r) => r[nameAt]?.trim() ?? '');
  return { ok: true, csv, mapping: body, rowCount: rows.length, names, fingerprint: JSON.stringify([csv, FIELDS.map((f) => mapping[f] || null)]) };
}

// ---------------------------------------------------------------------------------------------------------
// The report

export interface RowReport {
  /** The API's number: students counted from 1, the header row and blank lines not counted. */
  row: number;
  /** What the file says in the student-name column for that row, so staff find it whatever the spreadsheet's own row numbers. */
  name: string;
  problems: { column: string; message: string }[];
}

/**
 * The API's errors grouped by row, rows in order, each row's problems in the order the API gave them. `names` are
 * the file's student names in order (the API's row n is `names[n - 1]`).
 */
export function reportByRow(errors: RosterImportResult['errors'], names: readonly string[] = []): RowReport[] {
  const byRow = new Map<number, RowReport>();
  for (const e of errors) {
    const entry = byRow.get(e.row) ?? { row: e.row, name: names[e.row - 1] ?? '', problems: [] };
    entry.problems.push({ column: e.column, message: e.message });
    byRow.set(e.row, entry);
  }
  return [...byRow.values()].sort((a, b) => a.row - b.row);
}

export type View =
  | { kind: 'validated'; rowCount: number }
  | { kind: 'committed'; rowCount: number }
  | { kind: 'rejected'; rowCount: number; rows: RowReport[]; rejectedRows: number };

/** What the screen shows for an answer. The error list outranks the status: any error is a rejection. */
export function viewOf(r: RosterImportResult, names: readonly string[] = []): View {
  if (r.errors.length > 0 || r.status === 'rejected') {
    const rows = reportByRow(r.errors, names);
    return { kind: 'rejected', rowCount: r.rowCount, rows, rejectedRows: rows.length };
  }
  return { kind: r.status, rowCount: r.rowCount };
}

export interface Report {
  /** The input the answer was for. */
  fingerprint: string;
  view: View;
}

/** Commit only after a clean dry run of exactly what is on screen now. */
export const commitOffered = (report: Report | undefined, currentFingerprint: string | undefined): boolean =>
  report !== undefined && report.view.kind === 'validated' && currentFingerprint !== undefined && report.fingerprint === currentFingerprint;

// ---------------------------------------------------------------------------------------------------------
// Calling, with a key that a retry keeps

/**
 * The key a call goes with: the last attempt's for the same input and the same dry-run/commit choice, else new.
 * `unresolved` holds the key of every commit whose outcome is unknown (the call timed out or failed in a way that
 * does not say the server refused it, so the server may have committed), by input. A dry run in between does not replace it, and a later commit of the same input
 * goes with it, so the server replays the first answer instead of importing the students twice.
 */
export interface Attempt {
  change: string;
  key: string;
  unresolved?: Readonly<Record<string, string>>;
}
export const attemptFor = (last: Attempt | undefined, fingerprint: string, commit: boolean, newKey: () => string): Attempt => {
  const change = JSON.stringify([fingerprint, commit]);
  const unresolved = last?.unresolved;
  const pending = commit ? unresolved?.[fingerprint] : undefined;
  if (pending !== undefined) return { change, key: pending, ...(unresolved ? { unresolved } : {}) };
  if (last && last.change === change) return last;
  return { change, key: newKey(), ...(unresolved ? { unresolved } : {}) };
};

/**
 * The attempt when a new file is picked, or an import is done: the last attempt's key goes (it was for another input),
 * but the key of every commit with an unknown outcome stays, by input, so picking the same file again does not make
 * the next commit a new one. With nothing to keep it is `undefined`. (The empty `change` matches no input.)
 */
export const forgetFile = (attempt: Attempt | undefined): Attempt | undefined =>
  attempt?.unresolved ? { change: '', key: '', unresolved: attempt.unresolved } : undefined;

/** The attempt after a call: a commit with an unknown outcome stays unresolved; any other commit answer settles it. */
const settled = (attempt: Attempt, fingerprint: string, commit: boolean, unknown: boolean): Attempt => {
  if (!commit) return attempt;
  const rest = Object.fromEntries(Object.entries(attempt.unresolved ?? {}).filter(([fp]) => fp !== fingerprint));
  const unresolved = unknown ? { ...rest, [fingerprint]: attempt.key } : rest;
  return { change: attempt.change, key: attempt.key, ...(Object.keys(unresolved).length > 0 ? { unresolved } : {}) };
};

/** Codes that say the server refused the call: nothing was stored under its key. Any other failure is unknown. */
const REFUSALS: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'VALIDATION_FAILED', 'FORBIDDEN', 'NOT_FOUND']);

export const errorKey = (code: string): CopyKey =>
  code === 'UNAUTHENTICATED'
    ? 'import.error.signin'
    : code === 'VALIDATION_FAILED'
      ? 'import.error.invalid'
      : code === 'FORBIDDEN' || code === 'NOT_FOUND'
        ? 'import.error.forbidden'
        : 'import.error.generic';

/**
 * The sentence for a failed call. A commit that failed without a refusal may have gone through, so it must not say
 * that nothing was imported (that would send staff to start over); it says the result is unknown and that again is safe.
 */
const failureKey = (code: string | undefined, commit: boolean): CopyKey =>
  commit && (code === undefined || !REFUSALS.has(code)) ? 'import.error.commit' : errorKey(code ?? '');

export type Call = (body: RosterImportRequest, idempotencyKey: string) => Promise<Result<RosterImportResult>>;

export type Outcome = { kind: 'refused'; key: CopyKey } | { kind: 'failed'; key: CopyKey } | { kind: 'report'; report: Report };

/**
 * One check or one commit. A refusal never reaches `call`. The attempt comes back whatever the answer, so a retry
 * of a failed call goes with the same key (the API answers a repeat with the first answer); a refusal leaves
 * the last attempt as it was.
 */
export async function run(call: Call, text: string, mapping: Mapping, commit: boolean, last: Attempt | undefined, newKey: () => string): Promise<{ outcome: Outcome; attempt: Attempt | undefined }> {
  const prepared = prepare(text, mapping);
  if (!prepared.ok) return { outcome: { kind: 'refused', key: prepared.key }, attempt: last };
  const attempt = attemptFor(last, prepared.fingerprint, commit, newKey);
  let answer: Result<RosterImportResult>;
  try {
    answer = await call({ csv: prepared.csv, mapping: prepared.mapping, commit }, attempt.key);
  } catch {
    return { outcome: { kind: 'failed', key: failureKey(undefined, commit) }, attempt: settled(attempt, prepared.fingerprint, commit, true) };
  }
  if (!answer.ok) {
    return { outcome: { kind: 'failed', key: failureKey(answer.code, commit) }, attempt: settled(attempt, prepared.fingerprint, commit, !REFUSALS.has(answer.code)) };
  }
  return {
    outcome: { kind: 'report', report: { fingerprint: prepared.fingerprint, view: viewOf(answer.value, prepared.names) } },
    attempt: settled(attempt, prepared.fingerprint, commit, false),
  };
}

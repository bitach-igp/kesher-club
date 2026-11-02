// T-0640 I05 import roster (TST-INS-001 at the screen): a BOM or a semicolon changes nothing about what is read;
// Hebrew and English headers guess the mapping; a mapping without the student-name column is refused before the
// call; the report groups the API's errors by row; Commit is offered only after a clean check of the same input;
// a retry keeps its key; the file's text stays text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Result } from './api.ts';
import { COPY } from './i18n.ts';
import {
  attemptFor,
  commitOffered,
  errorKey,
  forgetFile,
  guessMapping,
  parseCsv,
  prepare,
  previewRows,
  previewWidth,
  reportByRow,
  run,
  viewOf,
  type RosterImportRequest,
  type RosterImportResult,
} from './roster-import.ts';

const COMMA = 'Student name,Parent email,Student phone\nAvi Levi,avi.parent@example.com,+972501234567\nDana Bar,dana.parent@example.com,\n';
const SEMI = COMMA.replaceAll(',', ';');
const IMPORT_ID = '0190a0a0-0000-7000-8000-0000000000a1';
const MAPPING = { memberName: 'Student name', funderEmail: 'Parent email', memberPhone: 'Student phone' };

const result = (r: Partial<RosterImportResult> = {}): RosterImportResult => ({ importId: IMPORT_ID, status: 'validated', rowCount: 2, errors: [], ...r });
const rejected = result({
  status: 'rejected',
  errors: [
    { row: 2, column: 'Parent email', message: 'Parent email is required and must be a valid email' },
    { row: 1, column: 'Student phone', message: 'Phone must be E.164 (e.g. +972501234567)' },
    { row: 2, column: 'Student name', message: 'Duplicate of row 1' },
  ],
});

describe('T-0640 I05 import roster', () => {
  it('a BOM and a semicolon file read the same as a plain comma file', () => {
    const plain = parseCsv(COMMA);
    for (const text of [`\uFEFF${COMMA}`, SEMI, `\uFEFF${SEMI}`, COMMA.replaceAll('\n', '\r\n')]) {
      const read = parseCsv(text);
      expect(read.header).toEqual(plain.header);
      expect(read.rows).toEqual(plain.rows);
    }
    expect(parseCsv(SEMI).delimiter).toBe(';');
    expect(parseCsv(COMMA).delimiter).toBe(',');
    const sent = (text: string) => {
      const p = prepare(text, MAPPING);
      return p.ok ? p.csv : undefined;
    };
    expect(sent(`\uFEFF${SEMI}`)).toBe(sent(COMMA));
    expect(sent(COMMA)).toBeDefined();
  });

  it('quoted cells keep their delimiters and quotes, and blank lines are skipped as the API skips them', () => {
    const p = parseCsv('name;email\n"Levi; Avi";"a@b.co"\n\n"Says ""hi""";c@d.co\n');
    expect(p.rows).toEqual([['Levi; Avi', 'a@b.co'], ['Says "hi"', 'c@d.co']]);
    // Re-written comma-separated: a cell that holds a comma is quoted, one that holds only a semicolon is not.
    const sent = prepare('name;email\n"Levi, Avi";"a@b.co"\n"Bar; Dana";c@d.co\n', { memberName: 'name', funderEmail: 'email' });
    expect(sent.ok && sent.csv).toBe('name,email\n"Levi, Avi",a@b.co\nBar; Dana,c@d.co');
  });

  it('English and Hebrew headers guess the mapping; staff can still change it', () => {
    expect(guessMapping(parseCsv(COMMA).header)).toEqual(MAPPING);
    const he = parseCsv('\uFEFFשם התלמיד;אימייל ההורה;טלפון התלמיד;טלפון ההורה;מסלול\nאבי;a@b.co;;;א');
    expect(guessMapping(he.header)).toEqual({ memberName: 'שם התלמיד', funderEmail: 'אימייל ההורה', memberPhone: 'טלפון התלמיד', funderPhone: 'טלפון ההורה', programme: 'מסלול' });
    // Gershayim, geresh, and a parent's phone beside a plain phone column.
    expect(guessMapping(['שם', 'דוא"ל הורה', 'נייד הורה', 'טלפון'])).toEqual({ memberName: 'שם', funderEmail: 'דוא"ל הורה', funderPhone: 'נייד הורה', memberPhone: 'טלפון' });
    expect(guessMapping(['Name', 'E-mail', 'Parent Phone', 'Programme'])).toEqual({ memberName: 'Name', funderEmail: 'E-mail', funderPhone: 'Parent Phone', programme: 'Programme' });
    expect(guessMapping(['a', 'b'])).toEqual({});
    // The guess is a start: a header goes to one field only, and unknown headers are left unmapped.
    expect(guessMapping(['Name', 'Name 2'])).toEqual({ memberName: 'Name' });
    expect(guessMapping(['Phone'])).toEqual({ memberPhone: 'Phone' });
  });

  it('a mapping without the student-name column is refused before the call', async () => {
    expect(prepare(COMMA, { funderEmail: 'Parent email' })).toEqual({ ok: false, key: 'import.map.name' });
    expect(prepare(COMMA, { memberName: 'Student name' })).toEqual({ ok: false, key: 'import.map.email' });
    expect(prepare(COMMA, { memberName: 'Nope', funderEmail: 'Parent email' })).toEqual({ ok: false, key: 'import.map.unknown' });
    expect(prepare('Name,Name,Email\nA,B,a@b.co', { memberName: 'Name', funderEmail: 'Email' })).toEqual({ ok: false, key: 'import.map.duplicate' });
    expect(prepare('Name,Email\n', { memberName: 'Name', funderEmail: 'Email' })).toEqual({ ok: false, key: 'import.file.empty' });
    expect(prepare('', { memberName: 'Name', funderEmail: 'Email' })).toEqual({ ok: false, key: 'import.file.empty' });
    expect(prepare(`Name,Email\n${'A,a@b.co\n'.repeat(130_000)}`, { memberName: 'Name', funderEmail: 'Email' })).toEqual({ ok: false, key: 'import.file.large' });
    // The limit is on the JSON-encoded request, where each newline costs two bytes: this file is under the limit raw
    // (855 KB) but not as sent (950 KB), and a server action would refuse it.
    const rows = (n: number) => `Name,Email\n${'A,a@b.co\n'.repeat(n)}`;
    expect(new TextEncoder().encode(rows(95_000)).length).toBeLessThan(900_000);
    expect(prepare(rows(95_000), { memberName: 'Name', funderEmail: 'Email' })).toEqual({ ok: false, key: 'import.file.large' });
    expect(prepare(rows(80_000), { memberName: 'Name', funderEmail: 'Email' }).ok).toBe(true);
    // Quotes count double as well.
    expect(prepare(`Name,Email\n${'"A ""x""",a@b.co\n'.repeat(60_000)}`, { memberName: 'Name', funderEmail: 'Email' })).toEqual({ ok: false, key: 'import.file.large' });

    const calls: string[] = [];
    const call = async (_b: RosterImportRequest, key: string): Promise<Result<RosterImportResult>> => {
      calls.push(key);
      return { ok: true, value: result() };
    };
    const refused = await run(call, COMMA, { funderEmail: 'Parent email' }, false, undefined, () => 'key-1-00000');
    expect(refused.outcome).toEqual({ kind: 'refused', key: 'import.map.name' });
    expect(calls).toEqual([]);
    expect(refused.attempt).toBeUndefined();
    // A refusal leaves the last attempt exactly as it was, so a later retry still goes with its key.
    const last = { change: 'earlier', key: 'key-0-00000' };
    const again = await run(call, COMMA, { funderEmail: 'Parent email' }, true, last, () => 'key-1-00000');
    expect(again.outcome).toEqual({ kind: 'refused', key: 'import.map.name' });
    expect(again.attempt).toBe(last);
    expect(calls).toEqual([]);
  });

  it('the dry run sends the normalized CSV, only the mapped columns, and commit=false; Commit sends commit=true', async () => {
    const bodies: RosterImportRequest[] = [];
    const keys: string[] = [];
    const call = async (b: RosterImportRequest, key: string): Promise<Result<RosterImportResult>> => {
      bodies.push(b);
      keys.push(key);
      return { ok: true, value: result() };
    };
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const dry = await run(call, SEMI, MAPPING, false, undefined, next);
    expect(dry.outcome.kind).toBe('report');
    await run(call, SEMI, MAPPING, true, dry.attempt, next);
    expect(bodies.map((b) => b.commit)).toEqual([false, true]);
    expect(bodies[0]?.mapping).toEqual(MAPPING);
    expect(bodies[0]?.csv).toBe('Student name,Parent email,Student phone\nAvi Levi,avi.parent@example.com,+972501234567\nDana Bar,dana.parent@example.com,');
    // The API replays by key whatever the body, so a commit must never reuse the dry run's key.
    expect(n).toBe(2);
    expect(keys[0]).toBe('key-1-00000');
    expect(keys[1]).toBe('key-2-00000');
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('the report groups the API errors by row, with the API message and the column as written', () => {
    expect(reportByRow(rejected.errors)).toEqual([
      { row: 1, name: '', problems: [{ column: 'Student phone', message: 'Phone must be E.164 (e.g. +972501234567)' }] },
      {
        row: 2,
        name: '',
        problems: [
          { column: 'Parent email', message: 'Parent email is required and must be a valid email' },
          { column: 'Student name', message: 'Duplicate of row 1' },
        ],
      },
    ]);
    expect(reportByRow([])).toEqual([]);
    // The API counts students from 1 without the header or blank lines; the name finds the row in the spreadsheet.
    const named = prepare('Student name,Parent email\n\nAvi Levi,bad\n\n  Dana Bar ,dana@b.co\n', { memberName: 'Student name', funderEmail: 'Parent email' });
    expect(named.ok && named.names).toEqual(['Avi Levi', 'Dana Bar']);
    const byName = reportByRow(rejected.errors, named.ok ? named.names : []);
    expect(byName.map((r) => [r.row, r.name])).toEqual([[1, 'Avi Levi'], [2, 'Dana Bar']]);
    expect(reportByRow([{ row: 9, column: 'Student name', message: 'x' }], ['a']).map((r) => r.name)).toEqual(['']);
    const shown = viewOf(rejected, ['Avi Levi', 'Dana Bar']);
    expect(shown.kind === 'rejected' && shown.rows.map((r) => r.name)).toEqual(['Avi Levi', 'Dana Bar']);
    const v = viewOf(rejected);
    expect(v.kind).toBe('rejected');
    expect(v.kind === 'rejected' && v.rows.map((r) => r.row)).toEqual([1, 2]);
    expect(v.kind === 'rejected' && v.rejectedRows).toBe(2);
    // The API's own status is not trusted over its error list.
    expect(viewOf(result({ status: 'validated', errors: rejected.errors })).kind).toBe('rejected');
  });

  it('Commit stays disabled while any row is rejected, and after the input changed since the check', () => {
    const prepared = prepare(COMMA, MAPPING);
    if (!prepared.ok) throw new Error('prepared');
    const fp = prepared.fingerprint;
    expect(commitOffered(undefined, fp)).toBe(false);
    expect(commitOffered({ fingerprint: fp, view: viewOf(rejected) }, fp)).toBe(false);
    expect(commitOffered({ fingerprint: fp, view: viewOf(result()) }, fp)).toBe(true);
    expect(commitOffered({ fingerprint: fp, view: viewOf(result({ status: 'committed' })) }, fp)).toBe(false);
    const edited = prepare(COMMA, { ...MAPPING, programme: 'Student phone' });
    expect(edited.ok && edited.fingerprint).not.toBe(fp);
    expect(commitOffered({ fingerprint: fp, view: viewOf(result()) }, edited.ok ? edited.fingerprint : undefined)).toBe(false);
    expect(commitOffered({ fingerprint: fp, view: viewOf(result()) }, undefined)).toBe(false);
    // Order of keys in the mapping is not a change.
    const reordered = prepare(COMMA, { memberPhone: 'Student phone', funderEmail: 'Parent email', memberName: 'Student name' });
    expect(reordered.ok && reordered.fingerprint).toBe(fp);
  });

  it('a retry keeps its key; a changed file, mapping or commit flag takes a new one', async () => {
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const keys: string[] = [];
    let fail = true;
    const call = async (_b: RosterImportRequest, key: string): Promise<Result<RosterImportResult>> => {
      keys.push(key);
      if (fail) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
      return { ok: true, value: result() };
    };
    const first = await run(call, COMMA, MAPPING, false, undefined, next);
    expect(first.outcome).toEqual({ kind: 'failed', key: 'import.error.generic' });
    fail = false;
    const retry = await run(call, COMMA, MAPPING, false, first.attempt, next);
    expect(retry.outcome.kind).toBe('report');
    expect(keys).toEqual(['key-1-00000', 'key-1-00000']);
    await run(call, COMMA, { ...MAPPING, programme: 'Student phone' }, false, retry.attempt, next);
    await run(call, `${COMMA}Eli Cohen,eli.parent@example.com,\n`, MAPPING, false, retry.attempt, next);
    await run(call, COMMA, MAPPING, true, retry.attempt, next);
    expect(keys.slice(2)).toEqual(['key-2-00000', 'key-3-00000', 'key-4-00000']);
    // Same input by a different delimiter or BOM is the same import.
    const same = await run(call, `\uFEFF${SEMI}`, MAPPING, false, retry.attempt, next);
    expect(same.attempt?.key).toBe('key-1-00000');

    const a = attemptFor(undefined, 'fp', false, next);
    expect(attemptFor(a, 'fp', false, next)).toBe(a);
    expect(attemptFor(a, 'fp', true, next).key).not.toBe(a.key);
  });

  it('after a commit with an unknown outcome, a re-check and a second commit go with the first commit\'s key', async () => {
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const seen: { commit: boolean; key: string }[] = [];
    let commitAnswer: Result<RosterImportResult> = { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    const call = async (b: RosterImportRequest, key: string): Promise<Result<RosterImportResult>> => {
      seen.push({ commit: b.commit, key });
      return b.commit ? commitAnswer : { ok: true, value: result() };
    };
    const dry = await run(call, COMMA, MAPPING, false, undefined, next);
    const lost = await run(call, COMMA, MAPPING, true, dry.attempt, next);
    // The server may have committed, so the message must not say nothing was imported.
    expect(lost.outcome).toEqual({ kind: 'failed', key: 'import.error.commit' });
    // The server may have committed. Staff check the file again (a new dry-run key), then import again.
    const recheck = await run(call, COMMA, MAPPING, false, lost.attempt, next);
    expect(recheck.outcome.kind).toBe('report');
    commitAnswer = { ok: true, value: result({ status: 'committed' }) };
    const again = await run(call, COMMA, MAPPING, true, recheck.attempt, next);
    expect(again.outcome.kind).toBe('report');
    expect(seen.map((s) => s.commit)).toEqual([false, true, false, true]);
    const commits = seen.filter((s) => s.commit).map((s) => s.key);
    expect(commits[1]).toBe(commits[0]);
    expect(seen[2]?.key).not.toBe(commits[0]);
    // A commit that was answered is settled: nothing stays unresolved (the screen then drops the attempt).
    expect(again.attempt?.unresolved).toBeUndefined();
    // A commit unknown for one input does not hand its key to a different input.
    const other = await run(call, COMMA, { ...MAPPING, programme: 'Student phone' }, true, { ...lost.attempt!, change: 'x' }, next);
    expect(other.attempt?.key).not.toBe(commits[0]);
    // A call that throws is unknown too.
    n = 100;
    const boom = async (): Promise<Result<RosterImportResult>> => {
      throw new Error('network');
    };
    const threw = await run(boom, COMMA, MAPPING, true, undefined, next);
    expect(threw.outcome).toEqual({ kind: 'failed', key: 'import.error.commit' });
    const seenKeys: string[] = [];
    const ok = async (_b: RosterImportRequest, key: string): Promise<Result<RosterImportResult>> => {
      seenKeys.push(key);
      return { ok: true, value: result() };
    };
    const between = await run(ok, COMMA, MAPPING, false, threw.attempt, next);
    await run(ok, COMMA, MAPPING, true, between.attempt, next);
    expect(seenKeys[1]).toBe(threw.attempt?.key);
  });

  it('after an unknown commit, picking the same file again still commits with the first key (forgetFile)', async () => {
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const seen: { commit: boolean; key: string }[] = [];
    let commitAnswer: Result<RosterImportResult> = { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    const call = async (b: RosterImportRequest, key: string): Promise<Result<RosterImportResult>> => {
      seen.push({ commit: b.commit, key });
      return b.commit ? commitAnswer : { ok: true, value: result() };
    };
    const dry = await run(call, COMMA, MAPPING, false, undefined, next);
    const lost = await run(call, COMMA, MAPPING, true, dry.attempt, next);
    expect(lost.outcome).toEqual({ kind: 'failed', key: 'import.error.commit' });
    // Staff pick the same file again: the screen forgets the file, not the unknown commit.
    const picked = forgetFile(lost.attempt);
    expect(picked?.unresolved).toEqual(lost.attempt?.unresolved);
    const recheck = await run(call, COMMA, MAPPING, false, picked, next);
    expect(recheck.outcome.kind).toBe('report');
    commitAnswer = { ok: true, value: result({ status: 'committed' }) };
    const again = await run(call, COMMA, MAPPING, true, recheck.attempt, next);
    expect(again.outcome.kind).toBe('report');
    const commits = seen.filter((s) => s.commit).map((s) => s.key);
    expect(commits).toHaveLength(2);
    expect(commits[1]).toBe(commits[0]);
    expect(seen[2]?.key).not.toBe(commits[0]);
    // The commit was answered: nothing is left to remember once the import is done.
    expect(forgetFile(again.attempt)).toBeUndefined();
    // A different file after the unknown commit does not take its key, and the unknown one stays remembered.
    const other = await run(call, `${COMMA}Eli Cohen,eli.parent@example.com,\n`, MAPPING, true, forgetFile(lost.attempt), next);
    expect(other.attempt?.key).not.toBe(commits[0]);
    expect(other.attempt?.unresolved).toEqual(lost.attempt?.unresolved);
    // Nothing unknown, nothing kept; a dry run alone is forgotten.
    expect(forgetFile(undefined)).toBeUndefined();
    expect(forgetFile(dry.attempt)).toBeUndefined();
  });

  it('a commit the server refused is not unknown, a commit that may have gone through says so', async () => {
    let n = 0;
    const next = () => `key-${++n}-00000`;
    for (const code of ['VALIDATION_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED']) {
      const refused = await run(async () => ({ ok: false, code }), COMMA, MAPPING, true, undefined, next);
      expect(refused.outcome).toEqual({ kind: 'failed', key: errorKey(code) });
      expect(refused.attempt?.unresolved).toBeUndefined();
      expect(forgetFile(refused.attempt)).toBeUndefined();
    }
    for (const code of ['PROVIDER_UNAVAILABLE', 'INTERNAL', 'IDEMPOTENCY_CONFLICT']) {
      const unknown = await run(async () => ({ ok: false, code }), COMMA, MAPPING, true, undefined, next);
      expect(unknown.outcome).toEqual({ kind: 'failed', key: 'import.error.commit' });
      expect(Object.values(unknown.attempt?.unresolved ?? {})).toEqual([unknown.attempt?.key]);
    }
    // A dry run changes nothing on the server, so its failure keeps the plain message and is never unknown.
    const dry = await run(async () => ({ ok: false, code: 'PROVIDER_UNAVAILABLE' }), COMMA, MAPPING, false, undefined, next);
    expect(dry.outcome).toEqual({ kind: 'failed', key: 'import.error.generic' });
    expect(dry.attempt?.unresolved).toBeUndefined();
    // The message says the result is unknown, and that importing again from this page adds no one twice.
    expect(COPY.en['import.error.commit']).not.toMatch(/Nothing was imported/);
    expect(COPY.en['import.error.commit']).toMatch(/from this page/);
    expect(COPY.he['import.error.commit']).not.toBe(COPY.he['import.error.generic']);
  });

  it('a quote in the middle of a cell is text; only a quote at the start of a cell opens quoting', () => {
    const p = parseCsv('Name,Height\nAvi,5" tall\nDana,"4\'11"""\nEli,x\n');
    expect(p.rows).toEqual([['Avi', '5" tall'], ['Dana', '4\'11"'], ['Eli', 'x']]);
    expect(parseCsv('a;b\n5" tall;"x;y"\n').rows).toEqual([['5" tall', 'x;y']]);
    expect(parseCsv('5" tall, 6" long;x\n1;2\n').delimiter).toBe(',');
    const sent = prepare('Name,Height\nAvi,5" tall\n', { memberName: 'Name', funderEmail: 'Height' });
    expect(sent.ok && sent.csv).toBe('Name,Height\nAvi,"5"" tall"');
  });
  it('a semicolon file whose quoted header holds commas is still read as semicolons', () => {
    const p = parseCsv('"Name, full";"Parent email, main"\nAvi Levi;a@b.co\n');
    expect(p.delimiter).toBe(';');
    expect(p.header).toEqual(['Name, full', 'Parent email, main']);
    expect(p.rows).toEqual([['Avi Levi', 'a@b.co']]);
    expect(guessMapping(['Name', 'Email'])).toEqual({ memberName: 'Name', funderEmail: 'Email' });
    const sent = prepare('"Name, full";"Parent email, main"\nAvi Levi;a@b.co\n', { memberName: 'Name, full', funderEmail: 'Parent email, main' });
    expect(sent.ok && sent.csv).toBe('"Name, full","Parent email, main"\nAvi Levi,a@b.co');
  });

  it('the preview is as wide as the widest row it shows, so staff see every cell that is sent', () => {
    const p = parseCsv('Name,Email\nAvi,a@b.co,extra,more\nDana,d@b.co\n');
    expect(previewWidth(p, 5)).toBe(4);
    expect(previewWidth(p, 0)).toBe(2);
    expect(previewWidth(parseCsv('a,b,c\n1,2\n'), 5)).toBe(3);
    const sent = prepare('Name,Email\nAvi,a@b.co,extra\n', { memberName: 'Name', funderEmail: 'Email' });
    expect(sent.ok && sent.csv).toBe('Name,Email\nAvi,a@b.co,extra');
  });

  it('the file text stays text: cells are plain strings, the screen never sets markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const p = parseCsv(`Name,Email\n${evil},"<script>alert(2)</script>@b.co"\n`);
    expect(p.rows).toEqual([[evil, '<script>alert(2)</script>@b.co']]);
    expect(previewRows(p, 5)).toEqual([[evil, '<script>alert(2)</script>@b.co']]);
    expect(previewRows(parseCsv('a,b\n1,2\n3,4\n5,6\n'), 2)).toEqual([['1', '2'], ['3', '4']]);
    for (const file of ['Import.tsx', 'page.tsx']) {
      const source = readFileSync(new URL(`../app/roster/import/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
    }
  });

  it('refusals read as sentences in both languages, and every import line is mirrored', () => {
    expect(errorKey('UNAUTHENTICATED')).toBe('import.error.signin');
    expect(errorKey('VALIDATION_FAILED')).toBe('import.error.invalid');
    expect(errorKey('FORBIDDEN')).toBe('import.error.forbidden');
    expect(errorKey('NOT_FOUND')).toBe('import.error.forbidden');
    expect(errorKey('PROVIDER_UNAVAILABLE')).toBe('import.error.generic');
    expect(errorKey('INTERNAL')).toBe('import.error.generic');
    for (const code of ['UNAUTHENTICATED', 'VALIDATION_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'PROVIDER_UNAVAILABLE', 'INTERNAL']) for (const locale of ['en', 'he'] as const) expect(COPY[locale][errorKey(code)]).toMatch(/\.$/);
    const mine = (Object.keys(COPY.en) as (keyof typeof COPY.en)[]).filter((k) => k.startsWith('import.'));
    expect(mine.length).toBeGreaterThan(20);
    // The label is short, since it repeats for every row; the counting rule is said once, in the heading.
    expect(COPY.he['import.report.row']).not.toMatch(/שורה \{row\}/);
    for (const locale of ['en', 'he'] as const) {
      expect(COPY[locale]['import.report.row']).not.toMatch(/[()]/);
      expect(COPY[locale]['import.report.row'].length).toBeLessThan(25);
      expect(COPY[locale]['import.report.rejected']).toMatch(/1/);
    }
    for (const k of mine) {
      expect(COPY.he[k]).toBeTruthy();
      expect(COPY.he[k]).not.toBe(COPY.en[k]);
      expect(COPY.he[k].match(/\{\w+\}/g)?.sort()).toEqual(COPY.en[k].match(/\{\w+\}/g)?.sort());
      expect(COPY.en[k] + COPY.he[k]).not.toMatch(/[<>]/);
    }
    expect(mine.map((k) => COPY.he[k]).join(' ')).toMatch(/[\u05D0-\u05EA]/);
  });
});

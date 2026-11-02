'use client';
// I05's screen (T-0640): read the CSV in the browser, match the columns, check it as a dry run, import after a clean
// check. The decisions live in src/roster-import.ts. Everything from the file (headers, cells) and the API's
// messages is rendered as React text children, never as markup.
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { t, type CopyKey, type Locale } from '../../../src/i18n.ts';
import {
  commitOffered,
  FIELDS,
  forgetFile,
  guessMapping,
  MAX_BYTES,
  parseCsv,
  prepare,
  previewRows,
  previewWidth,
  REQUIRED,
  run,
  setColumn,
  type Attempt,
  type Field,
  type Mapping,
  type ParsedCsv,
  type Report,
} from '../../../src/roster-import.ts';
import { importRoster } from './actions.ts';

const PREVIEW_ROWS = 5;

export function RosterImport({ locale }: { locale: Locale }) {
  const [text, setText] = useState<string | undefined>();
  const [mapping, setMapping] = useState<Mapping>({});
  const [report, setReport] = useState<Report | undefined>();
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  const [message, setMessage] = useState<{ key: CopyKey; vars?: Record<string, number>; error?: boolean } | undefined>();

  const parsed: ParsedCsv | undefined = useMemo(() => (text === undefined ? undefined : parseCsv(text)), [text]);
  const prepared = useMemo(() => (text === undefined ? undefined : prepare(text, mapping)), [text, mapping]);
  const fingerprint = prepared?.ok ? prepared.fingerprint : undefined;
  const offered = commitOffered(report, fingerprint);
  const stale = report?.view.kind === 'validated' && !offered;
  const width = parsed ? previewWidth(parsed, PREVIEW_ROWS) : 0;
  const columns = useMemo(() => [...new Set((parsed?.header ?? []).filter((h) => h !== ''))], [parsed]);

  // Bumped whenever the file is replaced: a read or a reply that belongs to an earlier file is dropped.
  const generation = useRef(0);

  const forget = () => {
    generation.current++;
    setText(undefined);
    setMapping({});
    setReport(undefined);
    // Not the keys of commits whose outcome is unknown: the same file picked again must still commit with its key.
    setAttempt(forgetFile);
    setMessage(undefined);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    forget();
    const mine = generation.current;
    if (!file) return;
    if (file.size > MAX_BYTES * 2) return setMessage({ key: 'import.file.large', error: true });
    let read: string;
    try {
      read = await file.text();
    } catch {
      return mine === generation.current ? setMessage({ key: 'import.file.unreadable', error: true }) : undefined;
    }
    if (mine !== generation.current) return;
    // Bytes that are not UTF-8 (a Hebrew export in Windows-1255, say) decode to U+FFFD; better to say so than to show garbage.
    if (read.includes('\uFFFD')) return setMessage({ key: 'import.file.unreadable', error: true });
    const p = parseCsv(read);
    if (p.header.length === 0 || p.rows.length === 0) return setMessage({ key: 'import.file.empty', error: true });
    setText(read);
    setMapping(guessMapping(p.header));
    setMessage({ key: 'import.file.loaded', vars: { rows: p.rows.length } });
  };

  const send = async (commit: boolean) => {
    if (text === undefined) return;
    const mine = generation.current;
    setBusy(true);
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(importRoster, text, mapping, commit, attempt, () => crypto.randomUUID());
    } catch {
      // `run` does not throw on a failed call; this is for the rest (no crypto.randomUUID off a secure page, say).
      if (mine === generation.current) setMessage({ key: 'import.error.generic', error: true });
      return;
    } finally {
      setBusy(false);
    }
    // The file was replaced while this was in flight: the answer is for a file that is no longer on screen.
    if (mine !== generation.current) return;
    setAttempt(r.attempt);
    if (r.outcome.kind !== 'report') return setMessage({ key: r.outcome.key, error: true });
    setReport(r.outcome.report);
    setMessage(undefined);
    if (r.outcome.report.view.kind === 'committed') {
      // Done: the same file cannot be imported twice by a second click. Other inputs' unknown commits stay remembered.
      setAttempt(forgetFile(r.attempt));
      setText(undefined);
      setMapping({});
      setFileKey((k) => k + 1);
    }
  };

  const view = report?.view;
  return (
    <>
      <div className="card">
        <label>
          {t('import.file', locale)}
          <br />
          <input key={fileKey} type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} disabled={busy} data-testid="import-file" />
        </label>
        <p className="muted">{t('import.file.hint', locale)}</p>
        {message ? (
          <p role={message.error ? 'alert' : 'status'} className={message.error ? 'error' : undefined} data-testid="import-message">
            {t(message.key, locale, message.vars)}
          </p>
        ) : null}
      </div>

      {parsed ? (
        <>
          <div className="card">
            <h2>{t('import.map.title', locale)}</h2>
            <div className="row">
              {FIELDS.map((field: Field) => (
                <label key={field}>
                  {t(`import.map.field.${field}`, locale)} {REQUIRED.includes(field) ? <span className="muted">{t('import.map.required', locale)}</span> : null}
                  <br />
                  <select value={mapping[field] ?? ''} disabled={busy} onChange={(e) => setMapping(setColumn(mapping, field, e.target.value))} data-testid={`import-map-${field}`}>
                    <option value="">{t('import.map.none', locale)}</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {prepared && !prepared.ok && prepared.key !== 'import.file.empty' ? (
              <p role="alert" className="error" data-testid="import-mapping-problem">
                {t(prepared.key, locale)}
              </p>
            ) : null}
          </div>

          <div className="card">
            <h2>{t('import.preview', locale)}</h2>
            <table data-testid="import-preview">
              <thead>
                <tr>
                  {Array.from({ length: width }, (_x, i) => (
                    <th key={i} dir="auto">
                      {parsed.header[i] ?? ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows(parsed, PREVIEW_ROWS).map((row, i) => (
                  <tr key={i}>
                    {Array.from({ length: width }, (_x, c) => (
                      <td key={c} dir="auto">
                        {row[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row">
            <button type="button" disabled={busy || !prepared?.ok} onClick={() => void send(false)} data-testid="import-check">
              {t('import.check', locale)}
            </button>
            <button type="button" className="primary" disabled={busy || !offered} onClick={() => void send(true)} data-testid="import-commit">
              {t('import.commit', locale)}
            </button>
          </div>
        </>
      ) : null}

      {stale ? (
        <p role="status" className="muted" data-testid="import-stale">
          {t('import.changed', locale)}
        </p>
      ) : null}

      {view?.kind === 'validated' && offered ? (
        <p role="status" data-testid="import-report-ok">
          {t('import.report.ok', locale, { rows: view.rowCount })}
        </p>
      ) : null}
      {view?.kind === 'committed' ? (
        <p role="status" data-testid="import-done">
          {t('import.done', locale, { rows: view.rowCount })}
        </p>
      ) : null}
      {view?.kind === 'rejected' ? (
        <div className="card" data-testid="import-report">
          <p role="alert" className="error">
            {t('import.report.rejected', locale, { bad: view.rejectedRows, rows: view.rowCount })}
          </p>
          <ul>
            {view.rows.map((r) => (
              <li key={r.row} data-testid={`import-report-row-${r.row}`}>
                <strong>{t('import.report.row', locale, { row: r.row })}</strong>
                {r.name ? (
                  <>
                    {' '}
                    <bdi data-testid={`import-report-name-${r.row}`}>{r.name}</bdi>
                  </>
                ) : null}
                <ul>
                  {r.problems.map((p, i) => (
                    <li key={i}>
                      <bdi>{p.column}</bdi>: <bdi>{p.message}</bdi>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

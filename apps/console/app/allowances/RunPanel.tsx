'use client';
// I07's interactive half (T-0610): preview a schedule's run for a date, run it with a passkey step-up, and
// Approve as the second finance member. The decisions live in src/allowances.ts; this renders them.
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { earlierRun, executeRun, fmt, previewRun, type PreviewView, type RunDeps, type RunSummary, type RunView } from '../../src/allowances.ts';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import { passkeyStepUp } from '../step-up-flow.ts';
import { previewAllowance, runAllowance } from './actions.ts';

function useDeps(): RunDeps {
  return useMemo<RunDeps>(
    () => ({
      preview: previewAllowance,
      run: runAllowance,
      stepUp: passkeyStepUp,
      newKey: () => crypto.randomUUID(),
    }),
    [],
  );
}

const errorKey = (code: string): CopyKey => (code === 'FORBIDDEN' ? 'error.forbidden' : 'error.generic');

function Outcome({ view, locale }: { view: RunView; locale: Locale }) {
  switch (view.kind) {
    case 'completed':
      return <p role="status" data-testid="run-done">{t('allowances.run.done', locale, { paid: view.run.memberCount, total: fmt(view.run.total, locale) })}</p>;
    case 'failed':
      return <p role="status" className="error" data-testid="run-failed">{t('allowances.run.failed', locale, { failures: view.run.failures ?? 0 })}</p>;
    case 'waiting':
      return <p role="status" data-testid="run-waiting">{t('allowances.run.waiting', locale)}</p>;
    case 'cancelled':
      return <p role="alert" className="error" data-testid="run-cancelled">{t('allowances.stepUp.cancelled', locale)}</p>;
    case 'off':
      return <p role="status" data-testid="run-off">{t('allowances.off', locale)}</p>;
    case 'error':
      return <p role="alert" className="error" data-testid="run-error">{t(errorKey(view.code), locale)}</p>;
  }
}

export function RunPanel({ scheduleId, defaultDate, locale, canRun, runs }: { scheduleId: string; defaultDate: string; locale: Locale; canRun: boolean; runs: readonly RunSummary[] }) {
  const deps = useDeps();
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewView | undefined>();
  const [outcome, setOutcome] = useState<RunView | undefined>();
  const already = earlierRun(runs, scheduleId, date);

  const doPreview = async () => {
    setBusy(true);
    setOutcome(undefined);
    setPreview(await previewRun(deps, scheduleId, date));
    setBusy(false);
  };
  const doRun = async () => {
    setBusy(true);
    const view = await executeRun(deps, scheduleId, date);
    setOutcome(view);
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="card">
      <div className="row">
        <label>
          {t('allowances.date', locale)}{' '}
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setPreview(undefined); setOutcome(undefined); }} data-testid="run-date" />
        </label>
        <button type="button" disabled={busy} onClick={() => void doPreview()} data-testid="run-preview">{t('allowances.preview', locale)}</button>
      </div>
      {already ? <p className="muted" data-testid="run-earlier">{already.requestedByMe && already.status === 'awaiting_second_approval' ? t('allowances.run.mine', locale) : t('allowances.run.earlier', locale, { date: already.runDate })}</p> : null}
      {preview?.kind === 'preview' ? (
        <>
          {preview.run.rows?.length ? (
            <table data-testid="preview-rows">
              <tbody>
                {preview.run.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.memberName}</td>
                    <td>{fmt(r.amount, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">{t('allowances.preview.empty', locale)}</p>}
          <p data-testid="preview-total"><strong>{t('allowances.preview.total', locale, { count: preview.run.memberCount, total: fmt(preview.run.total, locale) })}</strong></p>
          {canRun && !already && preview.run.memberCount > 0 && !outcome ? (
            <button className="primary" type="button" disabled={busy} onClick={() => void doRun()} data-testid="run-go">{t('allowances.run', locale)}</button>
          ) : null}
        </>
      ) : preview ? <Outcome view={preview.kind === 'off' ? { kind: 'off' } : { kind: 'error', code: preview.code }} locale={locale} /> : null}
      {outcome ? <Outcome view={outcome} locale={locale} /> : null}
    </div>
  );
}

/** The second finance member's Approve on a waiting run: the same run, posted again, with a step-up. */
export function ApproveButton({ scheduleId, runDate, locale }: { scheduleId: string; runDate: string; locale: Locale }) {
  const deps = useDeps();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RunView | undefined>();
  return (
    <>
      <button className="primary" type="button" disabled={busy || !!outcome} onClick={async () => { setBusy(true); setOutcome(await executeRun(deps, scheduleId, runDate)); setBusy(false); router.refresh(); }} data-testid={`approve-${scheduleId}-${runDate}`}>
        {t('allowances.approve', locale)}
      </button>
      {outcome ? <Outcome view={outcome} locale={locale} /> : null}
    </>
  );
}

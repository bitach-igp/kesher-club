'use client';
// The month's export (T-0611): the API's file, byte for byte, saved under the API's filename.
import { useState } from 'react';
import { decodeExport } from '../../src/collections.ts';
import { t, type Locale } from '../../src/i18n.ts';
import { exportMonth } from './actions.ts';

export function ExportButtons({ month, locale }: { month: string; locale: Locale }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const download = async (format: 'csv' | 'xlsx') => {
    setBusy(true);
    setMessage(undefined);
    const r = await exportMonth(month, format);
    setBusy(false);
    if (!r.ok) return setMessage({ ok: false, text: t(r.code === 'FORBIDDEN' ? 'error.forbidden' : 'error.generic', locale) });
    const bytes = decodeExport(r.value);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: r.value.contentType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.value.filename;
    a.click();
    URL.revokeObjectURL(url);
    setMessage({ ok: true, text: t('collections.export.done', locale, { filename: r.value.filename, rows: r.value.rows }) });
  };
  return (
    <div className="card">
      <strong>{t('collections.export', locale)}</strong>{' '}
      <span className="row" style={{ display: 'inline-flex' }}>
        <button type="button" disabled={busy} onClick={() => void download('csv')} data-testid="export-csv">{t('collections.export.csv', locale)}</button>
        <button type="button" disabled={busy} onClick={() => void download('xlsx')} data-testid="export-xlsx">{t('collections.export.xlsx', locale)}</button>
      </span>
      {message ? <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'muted' : 'error'} data-testid="export-message">{message.text}</p> : null}
    </div>
  );
}

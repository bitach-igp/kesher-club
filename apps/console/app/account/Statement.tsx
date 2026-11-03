'use client';
// I10's downloads (T-0646): the API's file, byte for byte, under the API's filename.
import { useState } from 'react';
import { decodeExport } from '../../src/collections.ts';
import { t, type Locale } from '../../src/i18n.ts';
import { exportStatement } from './actions.ts';

export function StatementDownloads({ month, currency, locale }: { month: string; currency: 'ILS' | 'USD'; locale: Locale }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const download = async (format: 'csv' | 'xlsx') => {
    setBusy(true);
    setMessage(undefined);
    const r = await exportStatement(month, currency, format);
    setBusy(false);
    if (!r.ok) return setMessage({ ok: false, text: t(r.code === 'FORBIDDEN' ? 'error.forbidden' : 'error.generic', locale) });
    const url = URL.createObjectURL(new Blob([decodeExport(r.value) as BlobPart], { type: r.value.contentType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.value.filename;
    a.click();
    URL.revokeObjectURL(url);
    setMessage({ ok: true, text: t('account.download.done', locale, { filename: r.value.filename }) });
  };
  return (
    <p className="row">
      <button type="button" disabled={busy} onClick={() => void download('csv')} data-testid="statement-csv">{t('account.download.csv', locale)}</button>
      <button type="button" disabled={busy} onClick={() => void download('xlsx')} data-testid="statement-xlsx">{t('account.download.xlsx', locale)}</button>
      {message ? <span role={message.ok ? 'status' : 'alert'} className={message.ok ? 'muted' : 'error'}>{message.text}</span> : null}
    </p>
  );
}

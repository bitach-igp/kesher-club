// I08 Collections (T-0611, REQ-INS-006): a month's paid fees with receipts, who still owes, per student,
// and the month's export. Fees only: no spend detail for any student (REQ-INS-005; see src/collections.ts).
import { redirect } from 'next/navigation';
import { institutionApi } from '../../src/api.ts';
import { fmt } from '../../src/allowances.ts';
import { byStudent, monthOf, shiftMonth, totalsMatch } from '../../src/collections.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { ExportButtons } from './Export.tsx';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  const asked = (await searchParams).month;
  const month = asked && MONTH.test(asked) ? asked : monthOf(new Date());
  const c = await institutionApi(getConfig().CONSOLE_API_URL, access).collections(landing.institution.id, month);
  const header = (
    <>
      <h1>{t('collections.title', locale)}</h1>
      <p className="row">
        <a href={`/collections?month=${shiftMonth(month, -1)}`}>{t('collections.prev', locale)}</a>
        <strong data-testid="collections-month">{t('collections.month', locale, { month })}</strong>
        <a href={`/collections?month=${shiftMonth(month, 1)}`}>{t('collections.next', locale)}</a>
      </p>
    </>
  );
  // A total that is not the sum of its rows is a bug to report, not a number to show.
  if (!totalsMatch(c)) {
    return (
      <>
        {header}
        <div className="card error" role="alert" data-testid="collections-mismatch">{t('collections.mismatch', locale)}</div>
      </>
    );
  }
  const students = byStudent(c);
  const money = (minor: bigint, currency: 'USD' | 'ILS') => fmt({ minor: minor.toString(), currency }, locale);
  return (
    <>
      {header}
      <h2>{t('collections.students', locale)}</h2>
      {students.length === 0 ? <p className="muted">{t('collections.students.none', locale)}</p> : (
        <table data-testid="collections-students">
          <tbody>
            {students.map((s) => (
              <tr key={`${s.currency}-${s.memberName}`}>
                <td>{s.memberName}</td>
                <td className={s.owed > 0n ? 'error' : 'muted'}>{s.owed > 0n ? t('collections.owes', locale, { amount: money(s.owed, s.currency) }) : '—'}</td>
                <td>{s.paid > 0n ? t('collections.paidMonth', locale, { amount: money(s.paid, s.currency) }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>{t('collections.owed', locale)}</h2>
      {c.owed.length === 0 ? <p className="muted">{t('collections.owed.none', locale)}</p> : (
        <table data-testid="collections-owed">
          <tbody>
            {c.owed.map((o) => (
              <tr key={o.feeItemId}>
                <td>{o.memberName}</td>
                <td>{o.description}</td>
                <td>{fmt(o.amount, locale)}</td>
                <td className="muted">{t('collections.due', locale, { date: o.dueAt })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p data-testid="collections-owed-total">{t('collections.total', locale, { amounts: c.owedTotal.map((m) => fmt(m, locale)).join(' + ') || '—' })}</p>
      <h2>{t('collections.paid', locale)}</h2>
      {c.items.length === 0 ? <p className="muted">{t('collections.paid.none', locale)}</p> : (
        <table data-testid="collections-paid">
          <tbody>
            {c.items.map((i) => (
              <tr key={i.receiptNumber}>
                <td>{i.memberName}</td>
                <td>{i.description}</td>
                <td>{fmt(i.amount, locale)}</td>
                <td className="muted">{t('collections.receipt', locale, { number: i.receiptNumber })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p data-testid="collections-paid-total">{t('collections.total', locale, { amounts: c.total.map((m) => fmt(m, locale)).join(' + ') || '—' })}</p>
      <ExportButtons month={month} locale={locale} />
    </>
  );
}

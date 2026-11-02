// I06 student detail (T-0642, REQ-INS-005): status, cohort, allowances paid and fees; spending only when the student
// shared it with the institution. Names and merchant names are text people or networks wrote, rendered as text.
import { redirect } from 'next/navigation';
import { fmt } from '../../../src/allowances.ts';
import { codeOf, institutionApi } from '../../../src/api.ts';
import { getConfig } from '../../../src/config.ts';
import { t } from '../../../src/i18n.ts';
import { requestContext } from '../../../src/request.ts';
import { owed, spendView } from '../../../src/student.ts';

export default async function StudentPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  const { memberId } = await params;
  let s;
  try {
    s = await institutionApi(getConfig().CONSOLE_API_URL, access).student(landing.institution.id, memberId);
  } catch (e) {
    const code = codeOf(e);
    if (!code) throw e;
    return <div className="card" role="status" data-testid="student-unavailable">{t(code === 'NOT_FOUND' ? 'student.notFound' : 'dash.unavailable', locale)}</div>;
  }
  const spend = spendView(s);
  const due = owed(s);
  return (
    <>
      <p><a href="/roster">{t('student.back', locale)}</a></p>
      <h1 data-testid="student-name">{s.member.name}</h1>
      <p>
        {t(`roster.status.${s.member.status}`, locale)} · {t(`roster.card.${s.member.card}`, locale)}
        {s.member.cohort ? <> · {t('student.cohort', locale, { name: s.member.cohort.name })}</> : null}
      </p>
      <div className="card" data-testid="student-allowances">
        <h2>{t('student.allowances', locale)}</h2>
        {s.allowances.length === 0 ? <p className="muted">{t('student.allowances.none', locale)}</p> : null}
        {s.allowances.map((a) => <p key={`${a.date}-${a.amount.minor}`}>{a.date} · {fmt(a.amount, locale)} · {t(`student.allowance.${a.status}`, locale)}</p>)}
      </div>
      <div className="card" data-testid="student-fees">
        <h2>{t('student.fees', locale)}</h2>
        {due.map((m) => <p key={m.currency}><strong data-testid="student-owed">{t('student.fees.owed', locale, { amount: fmt({ minor: m.minor.toString(), currency: m.currency }, locale) })}</strong></p>)}
        {s.fees.length === 0 ? <p className="muted">{t('student.fees.none', locale)}</p> : null}
        {s.fees.map((f) => <p key={f.id}>{f.description} · {fmt(f.amount, locale)} · {f.status === 'due' ? t('student.fee.due', locale, { date: f.dueAt }) : t(`student.fee.${f.status}`, locale)}</p>)}
      </div>
      <div className="card" data-testid="student-spend">
        <h2>{t('student.spend', locale)}</h2>
        {spend.kind === 'private' ? (
          <p className="muted" data-testid="student-spend-private">{t(spend.key, locale, { name: s.member.name, institution: landing.institution.name })}</p>
        ) : spend.rows.length === 0 ? (
          <p className="muted">{t('student.spend.none', locale)}</p>
        ) : (
          spend.rows.map((x) => <p key={`${x.at}-${x.merchant}`}>{x.at.slice(0, 10)} · {x.merchant} · {fmt(x.amount, locale)}</p>)
        )}
      </div>
    </>
  );
}

// Console copy (T-0610), English and Hebrew mirrored: every key exists in both, and the test keeps it so.
// Roster names, schedule names and staff display names are data, never copy: they are passed in as vars.
export type Locale = 'en' | 'he';

const en = {
  'nav.home': 'Home',
  'nav.allowances': 'Allowances',
  'allowances.title': 'Allowances',
  'allowances.off': 'Institution money is not switched on yet. Allowances appear here once it is.',
  'allowances.schedules': 'Schedules',
  'allowances.schedules.none': 'No active schedules.',
  'allowances.history': 'Run history',
  'allowances.history.none': 'No runs yet.',
  'allowances.cadence.weekly': 'Weekly',
  'allowances.cadence.monthly': 'Monthly',
  'allowances.cadence.once': 'Once',
  'allowances.cohort.all': 'Every active member ({count})',
  'allowances.cohort.listed': '{count} listed members',
  'allowances.next': 'Next: {date}',
  'allowances.open': 'Preview and run',
  'allowances.status.preview': 'Previewed',
  'allowances.status.awaiting_second_approval': 'Waiting for a second finance approver',
  'allowances.status.running': 'Running',
  'allowances.status.completed': 'Completed',
  'allowances.status.failed': 'Completed with failures',
  'allowances.requestedBy': 'Asked by {name}',
  'allowances.approvedBy': 'Approved by {names}',
  'allowances.paid': '{paid} paid, {failed} failed · {paidTotal} of {total}',
  'allowances.approve': 'Approve',
  'allowances.date': 'Run date',
  'allowances.preview': 'Preview',
  'allowances.preview.total': 'Total for {count} members: {total}',
  'allowances.preview.empty': 'No active members to pay on this schedule.',
  'allowances.run': 'Run with passkey',
  'allowances.run.done': 'Paid {paid} members, {total}.',
  'allowances.run.failed': 'Paid with {failures} failures. The history shows who was not paid.',
  'allowances.run.waiting': 'Over ₪5,000: waiting for a second finance approver.',
  'allowances.run.earlier': 'This run already happened on {date}. Running it again pays nobody twice.',
  'allowances.run.mine': 'You asked for this run. A different finance member approves it.',
  'allowances.stepUp.cancelled': 'The passkey confirmation was cancelled. Nothing was paid.',
  'error.forbidden': 'Only finance staff of this institution can do that.',
  'error.generic': 'Something went wrong. Nothing was paid; try again.',
} as const;

export type CopyKey = keyof typeof en;

const he: Record<CopyKey, string> = {
  'nav.home': 'בית',
  'nav.allowances': 'דמי כיס',
  'allowances.title': 'דמי כיס',
  'allowances.off': 'כספי המוסד עוד לא הופעלו. דמי הכיס יופיעו כאן כשיופעלו.',
  'allowances.schedules': 'תוכניות',
  'allowances.schedules.none': 'אין תוכניות פעילות.',
  'allowances.history': 'היסטוריית הרצות',
  'allowances.history.none': 'עדיין אין הרצות.',
  'allowances.cadence.weekly': 'שבועי',
  'allowances.cadence.monthly': 'חודשי',
  'allowances.cadence.once': 'חד־פעמי',
  'allowances.cohort.all': 'כל החברים הפעילים ({count})',
  'allowances.cohort.listed': '{count} חברים ברשימה',
  'allowances.next': 'הבא: {date}',
  'allowances.open': 'תצוגה מקדימה והרצה',
  'allowances.status.preview': 'נבדק מראש',
  'allowances.status.awaiting_second_approval': 'ממתין לאישור של איש כספים נוסף',
  'allowances.status.running': 'בהרצה',
  'allowances.status.completed': 'הושלם',
  'allowances.status.failed': 'הושלם עם כשלים',
  'allowances.requestedBy': 'התבקש על ידי {name}',
  'allowances.approvedBy': 'אושר על ידי {names}',
  'allowances.paid': '{paid} שולמו, {failed} נכשלו · {paidTotal} מתוך {total}',
  'allowances.approve': 'אישור',
  'allowances.date': 'תאריך הרצה',
  'allowances.preview': 'תצוגה מקדימה',
  'allowances.preview.total': 'סך הכול ל־{count} חברים: {total}',
  'allowances.preview.empty': 'אין חברים פעילים לתשלום בתוכנית הזו.',
  'allowances.run': 'הרצה עם מפתח גישה',
  'allowances.run.done': 'שולמו {paid} חברים, {total}.',
  'allowances.run.failed': 'שולם עם {failures} כשלים. ההיסטוריה מראה למי לא שולם.',
  'allowances.run.waiting': 'מעל ‏5,000 ₪: ממתין לאישור של איש כספים נוסף.',
  'allowances.run.earlier': 'ההרצה הזו כבר בוצעה ב־{date}. הרצה חוזרת לא משלמת לאף אחד פעמיים.',
  'allowances.run.mine': 'ביקשת את ההרצה הזו. איש כספים אחר מאשר אותה.',
  'allowances.stepUp.cancelled': 'האישור במפתח הגישה בוטל. לא שולם דבר.',
  'error.forbidden': 'רק אנשי הכספים של המוסד יכולים לעשות זאת.',
  'error.generic': 'משהו השתבש. לא שולם דבר; נסו שוב.',
};

export const COPY: Record<Locale, Record<CopyKey, string>> = { en, he };

export function t(key: CopyKey, locale: Locale, vars: Record<string, string | number> = {}): string {
  return COPY[locale][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Hebrew when the browser asks for it first; English otherwise. */
export const localeFrom = (acceptLanguage: string | null | undefined): Locale => (/^\s*he\b/i.test(acceptLanguage ?? '') ? 'he' : 'en');
export const dirOf = (locale: Locale): 'rtl' | 'ltr' => (locale === 'he' ? 'rtl' : 'ltr');
export const intlLocale = (locale: Locale): 'he-IL' | 'en-US' => (locale === 'he' ? 'he-IL' : 'en-US');

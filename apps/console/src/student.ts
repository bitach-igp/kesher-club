// I06 student detail (T-0642, REQ-INS-005): one student's status, cohort, allowances paid and fees owed. Spend shows
// only when the API sent it, which it does only while the student's consent is live; without it the page says the
// student has not shared their spending, never "no spending". Merchant names are untrusted text: rendered as text,
// never as markup. Sums are bigint.
import { fromWire, money, type Money } from '@kesher/domain';
import type { Schemas } from '@kesher/sdk';
import type { CopyKey } from './i18n.ts';

export type Student = Schemas['InstitutionStudent'];

/** Fees still due, summed per currency in bigint. */
export function owed(s: Student): Money[] {
  const by = new Map<string, bigint>();
  for (const f of s.fees) if (f.status === 'due') by.set(f.amount.currency, (by.get(f.amount.currency) ?? 0n) + fromWire(f.amount).minor);
  return [...by].map(([c, minor]) => money(minor, c as 'ILS' | 'USD'));
}

/** What the spend section says: the rows, or the sentence for a student who has not consented. */
export function spendView(s: Student): { kind: 'shared'; rows: NonNullable<Student['spend']> } | { kind: 'private'; key: CopyKey } {
  return s.spend ? { kind: 'shared', rows: s.spend } : { kind: 'private', key: 'student.spend.private' };
}

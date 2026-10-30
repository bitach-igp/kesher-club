// T-0926 an institution's KYB review (screen rows of TST-INS-011): every blocking reason reads as words naming
// whom it is about; each capability says whether ADR-017's table and any open sanctions match leave it open;
// the proposer of a high-risk approval gets no Approve; support sees the page with no buttons; the decide form
// is checked before the call.
import { describe, expect, it } from 'vitest';
import type { AdminActor, KybView } from '../data/types.ts';
import { blockingWords, canApprove, canDispose, capabilities, parseDecisionForm } from './kyb.ts';

const CLEO: AdminActor = { subject: 'staff-compliance-1', roles: ['compliance'] };
const SAM: AdminActor = { subject: 'staff-support-1', roles: ['support'] };
const record = (over: Partial<KybView> = {}): KybView => ({
  decision: { status: 'needs_more_info', reasons: [] },
  people: [{ id: 'p-rivka', fullName: 'Rivka Example', roles: ['control', 'signatory'], kycTier: 'T1' }],
  checks: [{ id: 'c-hit', kind: 'sanctions', personId: 'p-rivka', result: 'hit', provider: 'simulator', evidenceRef: 'sim-screen:1:sdn', checkedAt: '2026-11-10T09:00:00Z' }],
  blocking: [],
  ...over,
});

describe('KYB review (T-0926)', () => {
  it('reads every blocking reason as words, naming the institution or the person', () => {
    const k = record();
    expect(['registry_not_clear', 'exempt_status_not_shown', 'sanctions_not_screened:institution', 'pep_not_screened:p-rivka', 'sanctions_hit_undisposed:c-hit', 'control_person_not_t2:p-rivka', 'no_control_person', 'pep_requires_high_risk'].map((c) => blockingWords(k, c))).toEqual([
      'The register does not show the institution active and in good standing.',
      'Exempt status is not shown (ניהול תקין in Israel, the IRS listing in the US), and no exception is recorded.',
      'The institution has not been screened against the sanctions lists.',
      'Rivka Example has not been screened for politically exposed persons.',
      'A potential sanctions match on Rivka Example waits for compliance to dispose of it.',
      'Rivka Example is a control person without approved T2 KYC.',
      'Name at least one control person.',
      'A politically exposed person is a true match, so an approval must be rated high risk.',
    ]);
    expect(blockingWords(k, 'something_new:x')).toBe('something_new:x');
  });

  it('says what each capability does under the decision, and what an open sanctions match suspends', () => {
    const open = (k: KybView) => capabilities(k).map((c) => `${c.capability}:${c.open ? 'open' : c.why}`);
    expect(open(record({ checks: [] }))).toEqual(['deposits:closed while needs more information', 'allowances:closed while needs more information', 'credit:closed while needs more information', 'payouts:closed while needs more information']);
    expect(open(record({ decision: { status: 'approved_with_limits', risk: 'medium', reasons: ['refresh_overdue'] }, checks: [] }))).toEqual(['deposits:open', 'allowances:open', 'credit:closed while approved with limits', 'payouts:open']);
    expect(open(record({ decision: { status: 'approved', risk: 'low', reasons: [] } }))).toEqual(['deposits:open', 'allowances:open', 'credit:suspended by an open sanctions match', 'payouts:suspended by an open sanctions match']);
    const disposed = record({ decision: { status: 'approved', risk: 'low', reasons: [] }, checks: [{ ...record().checks[0]!, disposition: { outcome: 'false_positive', note: 'Different person', decidedBy: 'x', decidedAt: '2026-11-10T10:00:00Z' } }] });
    expect(open(disposed).every((c) => c.endsWith(':open'))).toBe(true);
  });

  it('the proposer of a high-risk approval gets no Approve; another compliance member does; support gets no buttons', () => {
    const pending = (proposedByMe: boolean) => record({ pendingApproval: { id: 'apr-1', status: 'awaiting_second_approval', risk: 'high', outcome: 'approved', proposedByMe } });
    expect(canApprove(pending(true), CLEO)).toBe(false);
    expect(canApprove(pending(false), CLEO)).toBe(true);
    expect(canApprove(pending(false), SAM)).toBe(false);
    expect(canApprove(record(), CLEO)).toBe(false);
    const hit = record().checks[0]!;
    expect([canDispose(hit, CLEO), canDispose(hit, SAM), canDispose({ ...hit, result: 'clear' }, CLEO)]).toEqual([true, false, false]);
  });

  it('checks the decide form first: an approval names its risk; the other outcomes say why', () => {
    expect(parseDecisionForm({ status: 'approved', reasons: '', key: 'k1' })).toEqual({ ok: false, problems: ['risk'] });
    expect(parseDecisionForm({ status: 'rejected', reasons: '  ', key: 'k1' })).toEqual({ ok: false, problems: ['reasons'] });
    expect(parseDecisionForm({ status: 'maybe', key: 'k1' })).toEqual({ ok: false, problems: ['status'] });
    expect(parseDecisionForm({ status: 'approved', risk: 'high', reasons: ' Board checked \n\n PEP chair ', key: 'k1' })).toEqual({ ok: true, input: { status: 'approved', risk: 'high', reasons: ['Board checked', 'PEP chair'], key: 'k1' } });
    expect(parseDecisionForm({ status: 'needs_more_info', risk: 'low', reasons: 'Bank letter', key: 'k1' })).toEqual({ ok: true, input: { status: 'needs_more_info', reasons: ['Bank letter'], key: 'k1' } });
  });
});

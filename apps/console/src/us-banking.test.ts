// TST-INS-022, TST-INS-024 (T-0651, REQ-INS-022, REQ-INS-024): the US bank account screen's model. Each provider status renders its own state; the
// fund button is absent until the bank approved AND Kesher's review allows money; the person who asked cannot approve their own request; a
// quote and a request carry bigint minor units as strings, never a float; the application and the request keep their Idempotency-Key across a
// retry; English and Hebrew mirror each other.
import { describe, expect, it, vi } from 'vitest';
import { browserIp, institutionApi, type Result } from './api.ts';
import { COPY } from './i18n.ts';
import type { Landing } from './session.ts';
import { askQuote, bankingState, canApprove, canCancel, canFund, canStart, errorKey, fundingLine, partyIdOf, resumeBody, showsUsBanking, startBody, submitApprove, submitRequest, submitStart, type UsBanking, type UsBankingDeps, type UsFunding, type UsFundingQuote } from './us-banking.ts';

const landing = (role: 'staff' | 'finance' | 'admin'): Landing => ({ kind: 'dashboard', institution: { id: 'i1', name: 'Yeshiva', market: 'IL' }, role, paymentReference: 'KC-7M4QX2HD' });
const banking = (status: UsBanking['status'], moneyOpen = false): UsBanking => ({ status, moneyOpen });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const request = (over: Partial<UsFunding> = {}): UsFunding => ({ id: 'r1', status: 'awaiting_approval', amount: { minor: '100000', currency: 'USD' }, fee: { minor: '0', currency: 'USD' }, reference: 'KC-7M4QX2HD', holder: 'institution', requestedBy: 'me', createdAt: '2026-11-03T09:00:00Z', ...over });
const quote: UsFundingQuote = { quoteId: 'q1', amount: { minor: '100000', currency: 'USD' }, fee: { minor: '2500', currency: 'USD' }, expiresAt: '2026-11-03T09:10:00Z', holder: 'institution' };

function deps(over: Partial<UsBankingDeps> = {}): UsBankingDeps & { keys: string[] } {
  let n = 0;
  const keys: string[] = [];
  return {
    keys,
    start: vi.fn(async (_b, k) => (keys.push(k), ok({ status: 'pending' as const, holder: 'institution' as const, sharesPlatformAccount: false, formUrl: 'https://bank.example/form' }))),
    quote: vi.fn(async () => ok(quote)),
    request: vi.fn(async (_q, k) => (keys.push(k), ok(request()))),
    approve: vi.fn(async () => ok(request({ status: 'approved' }))),
    cancel: vi.fn(async () => ok(request({ status: 'cancelled' }))),
    stepUp: vi.fn(async () => true),
    newKey: () => `key-${++n}`,
    ...over,
  };
}

describe('the US bank account screen (TST-INS-022, T-0651)', () => {
  it('each provider status renders its own state, and an approved account waits for Kesher\'s review before it opens money', () => {
    expect(bankingState(banking('not_linked'))).toBe('usbank.state.not_linked');
    expect(bankingState(banking('pending'))).toBe('usbank.state.pending');
    expect(bankingState(banking('needs_info'))).toBe('usbank.state.needs_info');
    expect(bankingState(banking('rejected'))).toBe('usbank.state.rejected');
    expect(bankingState(banking('approved', true))).toBe('usbank.state.approved');
    expect(bankingState(banking('approved', false))).toBe('usbank.state.approved_kyb');
    for (const s of ['not_linked', 'pending', 'needs_info', 'rejected', 'approved'] as const) expect(COPY.en[bankingState(banking(s))]).toBeTruthy();
  });

  it('only finance staff and admins see the screen, and only an admin starts the application, and not once the bank decided', () => {
    expect(showsUsBanking(landing('staff'))).toBe(false);
    expect(showsUsBanking(landing('finance'))).toBe(true);
    expect(showsUsBanking(landing('admin'))).toBe(true);
    expect(showsUsBanking({ kind: 'signed_out' })).toBe(false);
    expect(canStart(landing('admin'), banking('not_linked'))).toBe(true);
    expect(canStart(landing('admin'), banking('approved', true))).toBe(false);
    expect(canStart(landing('finance'), banking('not_linked'))).toBe(false);
  });

  it('an application on the institution\'s own entity can be continued, and started again after a rejection, with the holder fixed and nothing typed again', () => {
    const own = (status: UsBanking['status']): UsBanking => ({ status, moneyOpen: false, holder: 'institution' });
    expect(canStart(landing('admin'), own('pending'))).toBe(true);
    expect(canStart(landing('admin'), own('needs_info'))).toBe(true);
    expect(canStart(landing('admin'), own('rejected'))).toBe(true);
    expect(canStart(landing('admin'), own('approved'))).toBe(false);
    expect(canStart(landing('admin'), { status: 'pending', moneyOpen: false, holder: 'platform' })).toBe(false);
    expect(resumeBody()).toEqual({ holder: 'institution' });
  });

  it('the bank\'s application form is opened for the person\'s own address: the console forwards the browser\'s', async () => {
    const seen: Record<string, string>[] = [];
    const fake = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ status: 'pending', holder: 'institution', sharesPlatformAccount: false }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await institutionApi('https://api.example', 'tok', 'step', { clientIp: '198.51.100.7', fetch: fake }).startUsBanking('i1', { holder: 'institution' }, 'key-0000001');
    expect(seen[0]!['x-forwarded-for']).toBe('198.51.100.7');
    expect(seen[0]!['idempotency-key']).toBe('key-0000001');
    await institutionApi('https://api.example', 'tok', 'step', { fetch: fake }).startUsBanking('i1', { holder: 'institution' }, 'key-0000002');
    expect(seen[1]!['x-forwarded-for']).toBeUndefined();
    // The last entry is the one the console's own proxy saw; anything before it is the client's claim.
    expect(browserIp('6.6.6.6, 198.51.100.7')).toBe('198.51.100.7');
    expect(browserIp('not an address')).toBeUndefined();
    expect(browserIp(null)).toBeUndefined();
  });

  it('the application of an own entity needs a legal name and a well-formed EIN; Kesher\'s company needs neither', () => {
    expect(startBody('platform', '', '')).toEqual({ holder: 'platform' });
    expect(startBody('institution', 'American Friends of Yeshiva', '12-3456789')).toEqual({ holder: 'institution', usEntity: { legalName: 'American Friends of Yeshiva', ein: '12-3456789' } });
    expect(startBody('institution', 'American Friends of Yeshiva', '123456789')).toBeDefined();
    expect(startBody('institution', '', '12-3456789')).toBeUndefined();
    expect(startBody('institution', 'X', '12-345')).toBeUndefined();
    expect(startBody('institution', 'X'.repeat(201), '12-3456789')).toBeUndefined();
  });

  it('the application keeps its Idempotency-Key across a retry that did not land, and asks for one step-up', async () => {
    const body = startBody('institution', 'American Friends of Yeshiva', '12-3456789');
    const d = deps({ start: vi.fn().mockResolvedValueOnce({ ok: false, code: 'STEP_UP_REQUIRED' }).mockResolvedValueOnce({ ok: false, code: 'PROVIDER_UNAVAILABLE' }).mockResolvedValue(ok({ status: 'pending', holder: 'institution', sharesPlatformAccount: false, formUrl: 'https://bank.example/form' })) });
    const first = await submitStart(d, body, undefined);
    expect(first.outcome).toEqual({ kind: 'error', code: 'PROVIDER_UNAVAILABLE' });
    expect(d.stepUp).toHaveBeenCalledTimes(1);
    const second = await submitStart(d, body, first.attempt);
    expect(second.outcome.kind).toBe('done');
    const keys = (d.start as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(new Set(keys).size).toBe(1);
    expect((await submitStart(d, undefined, undefined)).outcome).toEqual({ kind: 'invalid' });
  });
});

describe('funding the master account (TST-INS-024, T-0651)', () => {
  it('the fund button is absent until the bank approved and Kesher\'s review allows money', () => {
    expect(canFund(banking('approved', true))).toBe(true);
    expect(canFund(banking('approved', false))).toBe(false);
    expect(canFund(banking('pending', true))).toBe(false);
    expect(canFund(banking('not_linked'))).toBe(false);
    expect(canFund(banking('rejected', true))).toBe(false);
  });

  it('the requester cannot approve their own request; a second finance user or admin can; staff cannot', () => {
    expect(canApprove(request({ requestedBy: 'me' }), 'me', 'finance')).toBe(false);
    expect(canApprove(request({ requestedBy: 'me' }), 'other', 'finance')).toBe(true);
    expect(canApprove(request({ requestedBy: 'me' }), 'other', 'admin')).toBe(true);
    expect(canApprove(request({ requestedBy: 'me' }), 'other', 'staff')).toBe(false);
    expect(canApprove(request({ requestedBy: 'me' }), undefined, 'finance')).toBe(false);
    expect(canApprove(request({ status: 'approved' }), 'other', 'finance')).toBe(false);
  });

  it('a request can be cancelled until the bank sends', () => {
    expect(canCancel(request({ status: 'awaiting_approval' }))).toBe(true);
    expect(canCancel(request({ status: 'approved' }))).toBe(true);
    expect(canCancel(request({ status: 'in_transit', achStatus: 'pending' }))).toBe(true);
    expect(canCancel(request({ status: 'in_transit', achStatus: 'sent' }))).toBe(false);
    expect(canCancel(request({ status: 'sending' }))).toBe(false);
    expect(canCancel(request({ status: 'received' }))).toBe(false);
  });

  it('every status has a line of copy in both languages', () => {
    for (const s of ['awaiting_approval', 'approved', 'sending', 'in_transit', 'deposit_pending', 'received', 'returned', 'rejected', 'cancelled', 'failed', 'needs_review'] as const) {
      const key = fundingLine(request({ status: s }));
      expect(COPY.en[key], s).toBeTruthy();
      expect(COPY.he[key], s).toBeTruthy();
    }
  });

  it('amounts never pass through a float: dollars become bigint minor units sent as a string', async () => {
    const d = deps();
    // 0.1 + 0.2 and 2^53 + 1 dollars are where a float goes wrong.
    expect((await askQuote(d, '90,071,992,547,409.93')).outcome.kind).toBe('done');
    expect(d.quote).toHaveBeenLastCalledWith({ minor: '9007199254740993', currency: 'USD' });
    await askQuote(d, '0.30');
    expect(d.quote).toHaveBeenLastCalledWith({ minor: '30', currency: 'USD' });
    for (const bad of ['', '0', '-5', '1.234', 'abc', '1e3']) expect((await askQuote(d, bad)).outcome, bad).toEqual({ kind: 'invalid' });
    expect(d.quote).toHaveBeenCalledTimes(2);
  });

  it('a request is made once per quote: the key survives a retry, a lapsed quote is its own sentence, and a cancelled passkey requests nothing', async () => {
    const lapsed = deps({ request: vi.fn().mockResolvedValue({ ok: false, code: 'QUOTE_EXPIRED' }) });
    const r1 = await submitRequest(lapsed, quote, undefined);
    expect(r1.outcome).toEqual({ kind: 'error', code: 'QUOTE_EXPIRED' });
    expect(errorKey('QUOTE_EXPIRED')).toBe('usbank.error.quote_expired');
    const lost = deps({ request: vi.fn().mockResolvedValueOnce({ ok: false, code: 'PROVIDER_UNAVAILABLE' }).mockResolvedValue(ok(request())) });
    const a = await submitRequest(lost, quote, undefined);
    const b = await submitRequest(lost, quote, a.attempt);
    expect(b.outcome.kind).toBe('done');
    const keys = (lost.request as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(new Set(keys).size).toBe(1);
    const other = await submitRequest(lost, { ...quote, quoteId: 'q2' }, a.attempt);
    expect(other.attempt).toBeUndefined();
    const refused = deps({ request: vi.fn().mockResolvedValue({ ok: false, code: 'STEP_UP_REQUIRED' }), stepUp: vi.fn(async () => false) });
    expect((await submitRequest(refused, quote, undefined)).outcome).toEqual({ kind: 'cancelled' });
    expect(refused.request).toHaveBeenCalledTimes(1);
  });

  it('approving asks for a step-up and answers the request as it stands', async () => {
    const d = deps({ approve: vi.fn().mockResolvedValueOnce({ ok: false, code: 'STEP_UP_REQUIRED' }).mockResolvedValue(ok(request({ status: 'approved' }))) });
    const r = await submitApprove(d, 'r1');
    expect(r.outcome).toMatchObject({ kind: 'done', value: { status: 'approved' } });
    expect(d.stepUp).toHaveBeenCalledTimes(1);
    expect(errorKey('FORBIDDEN')).toBe('error.forbidden');
    expect(errorKey('FEATURE_OFF')).toBe('usbank.off');
    // While funding, FEATURE_OFF is the deposits path, not US banking (the page just showed the account).
    expect(errorKey('FEATURE_OFF', 'fund')).toBe('usbank.fund.off');
  });

  it('reads the signed-in person from the token and nothing else', () => {
    const token = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    expect(partyIdOf(token({ sub: 'party-1' }))).toBe('party-1');
    expect(partyIdOf(token({}))).toBeUndefined();
    expect(partyIdOf('garbage')).toBeUndefined();
    expect(partyIdOf(undefined)).toBeUndefined();
  });

  it('English and Hebrew mirror each other', () => {
    expect(Object.keys(COPY.he).sort()).toEqual(Object.keys(COPY.en).sort());
    for (const k of Object.keys(COPY.en)) if (k.startsWith('usbank.')) expect(COPY.he[k as keyof typeof COPY.he], k).toBeTruthy();
  });
});

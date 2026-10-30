// T-0931 A12 Ops queue (TST-ADM-005, TST-INS-015 at the screen): each kind in plain words and in the queue's order;
// support acts on nothing, a decided case offers nothing, a suspense credit is never offered Resolve and only
// finance record it; the note is 1 to 500 characters; a suspense case prefills the deposit form with its credit
// in bigint, and a payload that is not a credit prefills nothing; the filter ignores what it does not know.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { OpsCase } from '../data/types.ts';
import { memoryAdminData } from '../data/memory.ts';
import { actionsFor, depositPrefill, errorWords, filterFrom, groupByKind, KIND_WORDS, KINDS, parseNote, reasonWords } from './view.ts';

const suspense = (over: Partial<OpsCase> = {}): OpsCase => ({
  id: 'case-s',
  kind: 'suspense',
  severity: 'high',
  status: 'open',
  summary: 'ILS 5,000.00 by masav, no payment reference',
  payload: { reason: 'no_reference', provider: 'bank', creditId: 'c-1', rail: 'masav', amount: { minor: '9007199254740993', currency: 'ILS' }, bankReference: 'MSV-1', valueDate: '2026-11-09', remitterReference: '<a href="x">pay</a>' },
  openedAt: '2026-11-10T06:00:00Z',
  ...over,
});
const OPS = { subject: 'ops-1', roles: ['admin', 'ops'] };
const FIN = { subject: 'fin-1', roles: ['admin', 'finance'] };
const SUPPORT = { subject: 'sup-1', roles: ['admin', 'support'] };

describe('T-0931 ops queue model', () => {
  it('names every kind in plain words and groups the queue in its order, skipping empty kinds', () => {
    for (const k of KINDS) expect(KIND_WORDS[k].label, k).toMatch(/^[A-Z][a-z ,]+$/);
    const breakCase = suspense({ id: 'b', kind: 'balance_break', payload: {} });
    expect(groupByKind([breakCase, suspense()]).map((g) => [g.kind, g.cases.length])).toEqual([
      ['suspense', 1],
      ['balance_break', 1],
    ]);
    expect(reasonWords('no_reference')).toMatch(/no payment reference/);
    expect(reasonWords({ toString: () => 'no_reference' })).toBeUndefined();
  });

  it('offers actions by kind, status and role: support nothing, a suspense credit no Resolve, Record to finance only', () => {
    expect(actionsFor(suspense(), SUPPORT)).toEqual({ assign: false, resolve: false, dismiss: false, record: false });
    expect(actionsFor(suspense(), OPS)).toEqual({ assign: true, resolve: false, dismiss: true, record: false });
    expect(actionsFor(suspense(), FIN)).toEqual({ assign: true, resolve: false, dismiss: true, record: true });
    expect(actionsFor(suspense({ kind: 'balance_break', payload: {} }), FIN)).toEqual({ assign: true, resolve: true, dismiss: true, record: false });
    expect(actionsFor(suspense({ status: 'investigating', assignedTo: 'ops-1' }), OPS).assign).toBe(false);
    for (const status of ['resolved', 'dismissed'] as const) expect(actionsFor(suspense({ status }), FIN)).toEqual({ assign: false, resolve: false, dismiss: false, record: false });
    // A suspense payload that is not a credit cannot be recorded from.
    expect(actionsFor(suspense({ payload: { reason: 'no_reference' } }), FIN).record).toBe(false);
  });

  it('a note is 1 to 500 characters once trimmed', () => {
    expect(parseNote('  Returned to sender  ')).toEqual({ ok: true, note: 'Returned to sender' });
    expect(parseNote('   ')).toEqual({ ok: false, problem: 'note_missing' });
    expect(parseNote(undefined)).toEqual({ ok: false, problem: 'note_missing' });
    expect(parseNote('x'.repeat(500))).toMatchObject({ ok: true });
    expect(parseNote('x'.repeat(501))).toEqual({ ok: false, problem: 'note_too_long' });
    expect(errorWords('note_missing')).toMatch(/note/);
  });

  it("a suspense case prefills the deposit form with its credit, in bigint, the remitter's text kept as text", () => {
    expect(depositPrefill(suspense({ payload: { ...suspense().payload, institutionId: 'inst-1' } }))).toEqual({
      caseId: 'case-s',
      amount: money(9_007_199_254_740_993n, 'ILS'),
      rail: 'masav',
      bankReference: 'MSV-1',
      valueDate: '2026-11-09',
      remitterReference: '<a href="x">pay</a>',
      institutionId: 'inst-1',
    });
    expect(depositPrefill(suspense({ kind: 'deposit_not_on_statement' }))).toBeUndefined();
    const bad = suspense().payload;
    for (const payload of [{ ...bad, rail: 'swift' }, { ...bad, amount: { minor: '-5', currency: 'ILS' } }, { ...bad, amount: { minor: '5', currency: 'EUR' } }, { ...bad, valueDate: 'yesterday' }, { ...bad, bankReference: '' }]) {
      expect(depositPrefill(suspense({ payload })), JSON.stringify(payload)).toBeUndefined();
    }
  });

  it('the filter keeps known kinds and statuses and "mine", and drops anything else', () => {
    expect(filterFrom({ kind: 'suspense', status: 'open', mine: '1' })).toEqual({ kind: 'suspense', status: 'open', mine: true });
    expect(filterFrom({ kind: 'structuring', status: 'cleared', mine: 'yes' })).toEqual({});
  });

  it('recorded from its case, the credit resolves the case when a second finance member approves it; rejected, it frees the case', async () => {
    const data = memoryAdminData();
    const now = new Date('2026-11-10T09:00:00Z');
    const [c] = await data.listOpsCases({ kind: 'suspense' }, FIN);
    const prefill = depositPrefill(c!)!;
    const inst = (await data.listInstitutions())[0]!.id;
    await expect(data.decideOpsCase(c!.id, 'resolved', 'it is theirs', OPS, now)).rejects.toMatchObject({ code: 'INVALID' });
    const first = await data.recordDeposit(inst, { ...prefill, key: 'k-1' }, FIN, now);
    expect((await data.getOpsCase(c!.id))!.payload).toMatchObject({ depositId: first.id });
    await data.decideDeposit(first.id, 'reject', { subject: 'fin-2', roles: ['finance'] }, 'Wrong institution', now);
    expect((await data.getOpsCase(c!.id))!.payload).not.toHaveProperty('depositId');
    const second = await data.recordDeposit(inst, { ...prefill, key: 'k-2' }, FIN, now);
    await data.decideDeposit(second.id, 'approve', { subject: 'fin-2', roles: ['finance'] }, undefined, now);
    expect(await data.getOpsCase(c!.id)).toMatchObject({ status: 'resolved', note: `Recorded as deposit ${second.id}` });
    expect(await data.listOpsCases({ mine: true }, OPS)).toEqual([]);
    expect((await data.assignOpsCase('01932e5a-0000-7000-8000-0000000c5002', OPS, now)).assignedTo).toBe('ops-1');
    expect((await data.listOpsCases({ mine: true }, OPS)).map((x) => x.kind)).toEqual(['balance_break']);
    await expect(data.assignOpsCase('01932e5a-0000-7000-8000-0000000c5002', SUPPORT, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

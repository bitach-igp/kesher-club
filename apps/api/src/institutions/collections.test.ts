// Collections (T-0606, TST-INS-006) end to end: a paid fee item produces a receipt number, one journal and
// one settled transfer of kind fee (paid twice is the same receipt); a journal left without its row by a
// crash is caught up on the next read and the next pay; the institution's month lists it with the roster
// name as data; the export over HTTP carries the same totals; staff of another institution are refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import { feeKey, receiptNumber, type FeeItemView, type Receipt } from './collections.ts';
import { sheetCells, unzipStored, type ExportFile } from './export.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-10T09:00:00Z');
let member = '';
let access = '';
let stepUpToken = '';
let staffToken = '';
let otherStaffToken = '';
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);
let feeId = '';
let bigFeeId = '';
let crashFeeId = '';

const call = (method: string, url: string, body?: unknown, h: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization: `Bearer ${access}`, ...h }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const pay = (id: string, key: string, h: Record<string, string> = {}) => call('POST', `/v1/fee-items/${id}/pay`, undefined, { 'idempotency-key': key, 'x-step-up': stepUpToken, ...h });
const available = async () => (await app.services.accounts.purses(member)).find((p) => p.currency === 'ILS')!.available.minor;

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'institutions.money': true }) });
  const s = app.services;
  const started = await s.otp.start({ phone: '+972509000001', locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
  await runLoad(s.loads, { payerPartyId: member, memberPartyId: member, method: 'card', amount: money(30_000n, 'ILS'), paymentMethodId: 'pm_ok' }, 'col-fund', NOW);

  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Other', 'IL')`, [INST, OTHER]);
  await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, 'Noa Example', $3, 'active')`, [uuidv7(NOW), INST, member]);
  feeId = uuidv7(NOW);
  bigFeeId = uuidv7(NOW);
  crashFeeId = uuidv7(NOW);
  await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at) values ($1, $2, $3, 'Tuition, term 1 <b>', 12000, 'ILS', 'due', '2026-11-30'), ($4, $2, $3, 'Building fund', 500000, 'ILS', 'due', '2026-11-30'), ($5, $2, $3, 'Trip', 3000, 'ILS', 'due', '2026-10-31')`, [feeId, INST, member, bigFeeId, crashFeeId]);
  const staffA = uuidv7(NOW);
  const staffB = uuidv7(NOW);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'finance'), ($3, $4, 'finance')`, [staffA, INST, staffB, OTHER]);
  staffToken = (await s.tokens.issue({ partyId: staffA, deviceId: 'web', roles: ['org_finance'] })).accessToken;
  otherStaffToken = (await s.tokens.issue({ partyId: staffB, deviceId: 'web', roles: ['org_finance'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('TST-INS-006', () => {
  it('a paid fee item produces a receipt number and one journal; paying again is the same receipt; the member sees it on the list', async () => {
    const before = await available();
    const due = (await call('GET', '/v1/fee-items')).body as { items: FeeItemView[] };
    expect(due.items.map((f) => [f.status, f.description])).toEqual([
      ['due', 'Trip'],
      ['due', 'Tuition, term 1 <b>'],
      ['due', 'Building fund'],
    ]);
    expect((await pay(feeId, 'pay-fee-1', { 'x-step-up': '' })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const r = await pay(feeId, 'pay-fee-1');
    expect(r.status).toBe(200);
    const receipt = r.body as Receipt;
    const journal = (await db.query<{ id: string; kind: string; effective_at: string | Date; metadata: Record<string, unknown> }>(`select id, kind, effective_at, metadata from ledger.journal where idempotency_key = $1`, [feeKey(feeId)])).rows[0]!;
    expect(receipt).toEqual({ receiptNumber: receiptNumber(journal.id, NOW), feeItemId: feeId, institutionId: INST, institutionName: 'Yeshivat Example', memberPartyId: member, description: 'Tuition, term 1 <b>', amount: { minor: '12000', currency: 'ILS' }, paidAt: NOW.toISOString(), journalId: journal.id });
    expect(receipt.receiptNumber).toMatch(/^KC-202611-[0-9A-F]{12}$/);
    expect(receipt.receiptNumber.slice(-12)).toBe(journal.id.replaceAll('-', '').slice(-12).toUpperCase()); // the random tail, never the shared timestamp
    expect(journal.kind).toBe('fee');
    // The payment is a transfer like any other movement: kind fee, settled, carrying the journal.
    const transfer = await app.services.transfers.byKey(feeKey(feeId));
    expect(transfer).toMatchObject({ kind: 'fee', state: 'settled', fromPartyId: member, journalId: journal.id, amount: money(12_000n, 'ILS') });
    expect((await app.services.transfers.history(transfer!.id)).map((h) => h.to)).toEqual(['created', 'submitted', 'settled']);
    expect(journal.metadata).toMatchObject({ institutionId: INST, memberPartyId: member, feeItemId: feeId });
    expect(await available()).toBe(before - 12_000n);
    const sides = (await db.query<{ type: string; amount_minor: string }>(`select a.type::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by a.type::text`, [journal.id])).rows;
    expect(sides).toEqual([
      { type: 'institution_master', amount_minor: '-12000' },
      { type: 'wallet', amount_minor: '12000' },
    ]);
    // The fee lands in this institution's own account (T-0613), not a shared one, and the other institution holds nothing.
    expect(await app.services.accounts.institutionBalance(INST, 'ILS')).toEqual(money(12_000n, 'ILS'));
    expect(await app.services.accounts.institutionBalance(OTHER, 'ILS')).toEqual(money(0n, 'ILS'));
    // Again, with any key: the same receipt, nothing more moves.
    expect((await pay(feeId, 'pay-fee-2')).body).toEqual(receipt);
    expect(await available()).toBe(before - 12_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [feeKey(feeId)])).rows[0]).toEqual({ n: 1 });
    const after = (await call('GET', '/v1/fee-items')).body as { items: FeeItemView[] };
    expect(after.items.find((f) => f.id === feeId)).toMatchObject({ status: 'paid', receipt: { receiptNumber: receipt.receiptNumber } });
    // Not enough for the big one; someone else's fee is not found; a waived fee is final.
    expect((await pay(bigFeeId, 'pay-fee-big')).body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', available: '18000' });
    expect((await pay(uuidv7(NOW), 'pay-fee-ghost')).status).toBe(404);
    await db.query(`update org.fee_item set status = 'waived' where id = $1`, [bigFeeId]);
    expect((await pay(bigFeeId, 'pay-fee-waived')).body).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('a journal the ledger holds without its row (a crash after posting) reads as paid and is caught up by the next pay, with nothing moved twice', async () => {
    // The crash: the fee journal posted (dated in October), then the process died before the row and the transfer were touched.
    const s = app.services;
    const wallet = await s.accounts.memberAccount(member, 'wallet', 'ILS');
    const master = await s.accounts.institutionAccount(INST, 'ILS');
    const posted = await s.ledger.post({ idempotencyKey: feeKey(crashFeeId), kind: 'fee', effectiveAt: new Date('2026-10-20T10:00:00Z'), postings: [{ accountId: wallet, currency: 'ILS', amountMinor: 3_000n }, { accountId: master, currency: 'ILS', amountMinor: -3_000n }], metadata: { institutionId: INST, memberPartyId: member, feeItemId: crashFeeId, description: 'Trip' } });
    const before = await available();
    const list = (await call('GET', '/v1/fee-items')).body as { items: FeeItemView[] };
    expect(list.items.find((f) => f.id === crashFeeId)).toMatchObject({ status: 'paid', receipt: { journalId: posted.id, receiptNumber: receiptNumber(posted.id, new Date('2026-10-20T10:00:00Z')) } });
    expect((await db.query<{ status: string }>('select status from org.fee_item where id = $1', [crashFeeId])).rows[0]).toEqual({ status: 'due' });
    const r = await pay(crashFeeId, 'pay-fee-crash');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ journalId: posted.id, description: 'Trip', amount: { minor: '3000', currency: 'ILS' } });
    expect(await available()).toBe(before);
    expect((await db.query<{ status: string }>('select status from org.fee_item where id = $1', [crashFeeId])).rows[0]).toEqual({ status: 'paid' });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [feeKey(crashFeeId)])).rows[0]).toEqual({ n: 1 });
  });

  it('the institution\'s staff list the month with roster names as data and export it; the totals equal the ledger; other staff are refused', async () => {
    const owedId = uuidv7(NOW);
    await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at) values ($1, $2, $3, 'Lab fee', 4500, 'ILS', 'due', '2026-12-15')`, [owedId, INST, member]);
    const list = await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections?month=2026-11`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ month: '2026-11', items: [{ feeItemId: feeId, memberName: 'Noa Example', amount: { minor: '12000', currency: 'ILS' } }], total: [{ minor: '12000', currency: 'ILS' }] });
    // Who still owes (T-0611): the unpaid Lab fee, due next month, with its total in bigint text.
    expect(list.body).toMatchObject({ owed: [{ feeItemId: owedId, memberName: 'Noa Example', description: 'Lab fee', amount: { minor: '4500', currency: 'ILS' }, dueAt: '2026-12-15' }], owedTotal: [{ minor: '4500', currency: 'ILS' }] });
    // October holds the Trip the crash test left on the ledger; September nothing.
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections?month=2026-10`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW })).body).toMatchObject({ items: [{ feeItemId: crashFeeId, description: 'Trip', amount: { minor: '3000', currency: 'ILS' } }], total: [{ minor: '3000', currency: 'ILS' }] });
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections?month=2026-09`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW })).body).toMatchObject({ items: [], total: [] });
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections?month=2026-1`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections?month=2026-11`, headers: { authorization: `Bearer ${otherStaffToken}` }, rawBody: '', now: NOW })).body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections?month=2026-11`, headers: { authorization: `Bearer ${access}` }, rawBody: '', now: NOW })).body).toMatchObject({ code: 'FORBIDDEN' });

    const csv = await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections/export?month=2026-11&format=csv`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW });
    expect(csv.status).toBe(200);
    const f = csv.body as ExportFile;
    expect(f).toMatchObject({ filename: `kesher-${INST.slice(0, 8)}-2026-11-ILS.csv`, rows: 1, totals: { allowancesOut: { minor: '0' }, feesIn: { minor: '12000' }, net: { minor: '12000' } } });
    const text = Buffer.from(f.base64, 'base64').toString('utf8');
    expect(text).toContain('fee,Noa Example,');
    expect(text).toContain('"Tuition, term 1 <b>"');
    const xlsx = (await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections/export?month=2026-11&format=xlsx`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW })).body as ExportFile;
    const sheet = sheetCells(unzipStored(new Uint8Array(Buffer.from(xlsx.base64, 'base64'))).get('xl/worksheets/sheet1.xml')!);
    expect(sheet[1]).toEqual(['2026-11-10', expect.any(String), 'fee', 'Noa Example', member, 'Tuition, term 1 <b>', '12000', 'ILS', '₪120.00']);
    expect(sheet).toHaveLength(7);
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections/export?month=2026-11&format=pdf`, headers: { authorization: `Bearer ${staffToken}` }, rawBody: '', now: NOW })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await dispatch(app, { method: 'GET', url: `/v1/institutions/${INST}/collections/export?month=2026-11&format=csv`, headers: { authorization: `Bearer ${otherStaffToken}` }, rawBody: '', now: NOW })).body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

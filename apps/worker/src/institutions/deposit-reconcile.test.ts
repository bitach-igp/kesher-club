// TST-INS-007, the daily reconciliation (T-0618): yesterday's bank statement against the institution deposits. A
// credit whose notification was lost posts now, once; one already posted is left alone; one naming no
// institution is a suspense case; a deposit recorded for that day that the bank never saw opens a case; a second
// run changes nothing; with the feed off it asks the bank nothing; a bank outage fails the run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BankError, type BankPort } from '@kesher/ports';
import { createApp, type App } from '@kesher/api/app';
import { createRegistry } from '@kesher/api/registry';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { paymentReference } from '@kesher/api/institutions/deposits';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { decideKyb } from '@kesher/api/test-institution';
import { DepositReconcileJob } from './deposit-reconcile.ts';

let db: TestDatabase;
let app: App;
let host: ReturnType<typeof createRegistry>['simulators'];
const NOW = new Date('2026-11-10T04:30:00Z'); // 06:30 in Israel; the statement is for 2026-11-09
const INST = uuidv7(NOW);
const balance = async () => (await app.services.accounts.institutionBalance(INST, 'ILS')).minor;
const job = (a = app) => new DepositReconcileJob(a.services.deposits, () => host.simulators.bank, 'bank');

beforeAll(async () => {
  db = await createTestDatabase();
  host = createRegistry('sim').simulators;
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'institutions.deposits': true, 'institutions.bankFeed': true }) });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [INST]);
  await decideKyb(db, INST);
}, 60_000);
afterAll(async () => db.close());

describe('the daily deposit reconciliation (T-0618, TST-INS-007)', () => {
  it('posts a credit whose notification was lost, leaves a posted one alone, cases the rest, and a rerun changes nothing', async () => {
    const day = '2026-11-09';
    const bank = host.simulators.bank;
    // Notified and posted yesterday.
    const told = bank.credit({ rail: 'masav', amount: money(100_000n, 'ILS'), remitterReference: paymentReference(INST), valueDate: day });
    expect(await app.services.deposits.applyBankCredit(told.credit, 'bank', NOW)).toMatchObject({ kind: 'posted' });
    // On the statement, never notified.
    bank.withhold({ rail: 'masav', amount: money(250_000n, 'ILS'), remitterReference: `fees ${paymentReference(INST)}`, valueDate: day });
    bank.withhold({ rail: 'masav', amount: money(9_900n, 'ILS'), remitterReference: 'no reference at all', valueDate: day });
    // Recorded by hand for that day; the bank never saw it.
    await app.services.deposits.record(INST, { amount: { minor: '70000', currency: 'ILS' }, rail: 'wire', bankReference: 'TYPO-1', valueDate: day }, 'dep-typo-0001', { partyId: uuidv7(NOW), role: 'finance' }, NOW);
    expect(await balance()).toBe(100_000n);

    const first = await job().run(NOW);
    expect(first).toEqual({ valueDate: day, credits: 3, posted: 1, alreadyRecorded: 1, suspense: 1, notOnStatement: 1 });
    expect(await balance()).toBe(350_000n);
    const cases = await db.query<{ kind: string }>(`select kind from ops.case order by kind`);
    expect(cases.rows.map((c) => c.kind)).toEqual(['deposit_not_on_statement', 'suspense']);

    expect(await job().run(NOW)).toEqual({ valueDate: day, credits: 3, posted: 0, alreadyRecorded: 2, suspense: 1, notOnStatement: 1 });
    expect(await balance()).toBe(350_000n);
    expect((await db.query(`select 1 from ops.case`)).rowCount).toBe(2);
  });

  it('with the feed off it asks the bank nothing; a bank outage fails the run, so the scheduler retries it', async () => {
    const off = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'institutions.deposits': true }) });
    const asked: string[] = [];
    const spy: BankPort = { parseWebhook: () => Promise.reject(new Error('unused')), statement: async (i) => (asked.push(i.valueDate), []) };
    expect(await new DepositReconcileJob(off.services.deposits, () => spy, 'bank').run(NOW)).toMatchObject({ skipped: 'feed_off', credits: 0 });
    expect(asked).toEqual([]);
    await expect(job().run(new Date('2000-01-02T06:00:00Z'))).rejects.toBeInstanceOf(BankError);
  });
});

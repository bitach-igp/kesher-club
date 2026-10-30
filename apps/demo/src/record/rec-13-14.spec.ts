// Recorded walkthroughs REC-13 and REC-14 (T-0927) on the institution variant of the T-0920 harness: the
// institution console on the left, driven as the yeshiva's finance staff (Rivka asks, Shimon approves), the
// simulator panel, the member app, and the admin console's view of the money.
// REC-13: Kesher finance records a ₪20,000.00 Masav deposit and a second finance member approves it; Rivka
// withdraws ₪6,000.00 to the yeshiva's own verified account; it cools off 24 hours as the account's first payout
// over ₪2,000, then waits for Shimon, then the rail settles it; the yeshiva holds ₪14,000.00.
// REC-14: Rivka makes a weekly ₪2,000.00 schedule for the three students who joined from their invites, previews
// and runs it; ₪6,000.00 is over ₪5,000, so Shimon approves; each student's shekel purse gains 200,000 agorot.
// Every amount is asserted against docs/bank-review/money-flows.md §13 and §14 in minor units.
import { expect, test } from '@playwright/test';
import { INSTITUTION, PERSONAS } from '../personas.ts';
import { customerByApi, homeAvailable, minorOf, money, openInstitution, openRecording, panel, partyByPhone, signInInstitution, signInMember, staffApi, switchMember, URLS, type Recording } from './flows.ts';

const phone = (key: string) => PERSONAS.find((p) => p.key === key)!.phone;
const units = (minor: bigint): string => minor.toLocaleString('en-US');
const ils = (minor: bigint) => ({ minor: minor.toString(), currency: 'ILS' as const });
const DAY_MS = 86_400_000;
const STUDENTS = INSTITUTION.roster.students.map((s) => s.persona);
/** Kesher's own finance staff in the admin API (T-0614): one records a deposit, a different one approves it. */
const KESHER_FINANCE = [{ subject: 'staff-finance-1', roles: ['finance'] }, { subject: 'staff-finance-2', roles: ['finance'] }] as const;

test.describe.configure({ mode: 'serial' });

async function yeshivaId(): Promise<string> {
  const { items } = await staffApi<{ items: { id: string; name: string }[] }>('GET', '/admin/institutions');
  const found = items.find((i) => i.name === INSTITUTION.name);
  if (!found) throw new Error(`No ${INSTITUTION.name}: did the seed run with the staff key?`);
  return found.id;
}

/** The yeshiva's shekel balance as Kesher finance reads it. */
async function yeshivaBalance(id: string): Promise<bigint> {
  const r = await staffApi<{ balances: { minor: string; currency: string }[] }>('GET', `/admin/institutions/${id}/deposits`, { subject: KESHER_FINANCE[0].subject, roles: [...KESHER_FINANCE[0].roles] });
  return BigInt(r.balances.find((b) => b.currency === 'ILS')?.minor ?? '0');
}

/** A Masav transfer in, recorded by one Kesher finance member and approved by another (money-flows §12). */
async function deposit(id: string, minor: bigint, bankReference: string): Promise<void> {
  const valueDate = (await panel.now()).toISOString().slice(0, 10);
  const [a, b] = KESHER_FINANCE;
  const recorded = await staffApi<{ id: string }>('POST', `/admin/institutions/${id}/deposits`, { subject: a.subject, roles: [...a.roles], key: `rec-deposit-${bankReference}`, body: { amount: ils(minor), rail: 'masav', bankReference, valueDate } });
  await staffApi('POST', `/admin/deposits/${recorded.id}/approve`, { subject: b.subject, roles: [...b.roles] });
}

/** The payout card's id and state text in the institution console's I09 list. */
async function latestPayout(rec: Recording): Promise<{ id: string; state: string }> {
  const card = rec.institution.locator('[data-testid^="payout-"]').filter({ has: rec.institution.getByTestId('payout-state') }).first();
  await card.waitFor({ timeout: 60_000 });
  return { id: (await card.getAttribute('data-testid'))!.replace(/^payout-/, ''), state: await card.getByTestId('payout-state').innerText() };
}

test('REC-13 institution withdrawal to its own account', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-13', name: 'institution-withdrawal', title: 'The yeshiva withdraws to its own bank account (money-flows §13)', persona: 'rivka', institution: true });
  const yeshiva = await yeshivaId();
  const start = await yeshivaBalance(yeshiva);

  await rec.caption('The yeshiva pays ₪20,000.00 into Kesher by Masav, quoting its payment reference. Kesher finance records it; a second finance member approves it; only then does it post.');
  await deposit(yeshiva, 2_000_000n, 'MASAV-REC13-0001');
  expect(await yeshivaBalance(yeshiva)).toBe(start + 2_000_000n);
  await rec.adminPage(`/institutions/${yeshiva}`, 'the yeshiva after the deposit');
  await rec.caption(`API: POST /admin/institutions/{id}/deposits, then /admin/deposits/{id}/approve by a different finance member. Journal deposit: Dr partner_settlement ILS 2,000,000; Cr the yeshiva's account ILS 2,000,000.`);

  await signInInstitution(rec, 'rivka');
  await openInstitution(rec, '/payouts');
  const available = rec.institution.getByTestId('payouts-available');
  await available.waitFor({ timeout: 120_000 });
  expect(minorOf(await available.innerText())).toBe(start + 2_000_000n);
  await rec.caption(`Rivka, the yeshiva's finance lead, opens Payouts (I09): ${money(start + 2_000_000n, 'ILS')} available. A withdrawal goes only to the yeshiva's own verified account, so the form asks for an amount and a reference.`);
  await rec.institution.getByTestId('payouts-new').click();
  await rec.institution.getByTestId('payout-destination').waitFor({ timeout: 120_000 });
  await rec.institution.getByTestId('payout-amountText').fill('6,000');
  await rec.institution.getByTestId('payout-reference').fill('Withdrawal to the yeshiva bank account');
  await rec.caption('She withdraws ₪6,000.00 (600,000 agorot) and confirms with her passkey.');
  await rec.institution.getByTestId('payout-submit').click();
  await rec.institution.getByTestId('payouts-available').waitFor({ timeout: 120_000 });
  const first = await latestPayout(rec);
  expect(first.state.toLowerCase()).toContain('cool');
  await rec.caption(`Cooling off: it is the account's first payout and above ₪2,000.00 (200,000 agorot), so it waits 24 hours with nothing moved. The balance is still ${money(start + 2_000_000n, 'ILS')}.`);
  expect(await yeshivaBalance(yeshiva)).toBe(start + 2_000_000n);

  await rec.caption('A day later: the panel moves the shared clock 24 hours and runs the payout sweep, as the worker would every minute.');
  await panel.advance(DAY_MS + 60_000);
  await rec.refreshPanel();
  await panel.runJob('payout-sweep');
  await signInInstitution(rec, 'rivka');
  await openInstitution(rec, '/payouts');
  await rec.institution.getByTestId('payout-mine').waitFor({ timeout: 120_000 });
  await rec.caption('Above ₪5,000.00 (500,000 agorot) a second finance member must approve. Rivka asked for it, so she is not offered Approve.');

  await signInInstitution(rec, 'shimon');
  await openInstitution(rec, '/payouts');
  await rec.institution.getByTestId(`approve-${first.id}`).waitFor({ timeout: 120_000 });
  await rec.caption('Shimon, the second finance member, approves it with his passkey. The journal posts and the rail is asked, under the same key.');
  await rec.institution.getByTestId(`approve-${first.id}`).click();
  await expect.poll(async () => (await latestPayout(rec)).state.toLowerCase(), { timeout: 60_000 }).not.toContain('approv');
  expect(await yeshivaBalance(yeshiva)).toBe(start + 1_400_000n);
  await rec.caption(`Journal payout: Dr the yeshiva's account ILS 600,000; Cr partner_settlement ILS 600,000. The yeshiva holds ${money(start + 1_400_000n, 'ILS')}.`);

  const rail = (await (await fetch(`${URLS.stack}/?payoutOf=${first.id}`)).json()) as { payoutId?: string };
  if (!rail.payoutId) throw new Error(`The rail has no payout for ${first.id}`);
  const signed = (await panel.hook('payout', 'nextWebhook', { payoutId: rail.payoutId })).result as { headers: Record<string, string>; rawBody: string };
  const hook = await fetch(`${URLS.api}/hooks/payout`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed.headers }, body: signed.rawBody });
  expect(hook.ok).toBe(true);
  await openInstitution(rec, '/payouts');
  await expect.poll(async () => (await latestPayout(rec)).state.toLowerCase(), { timeout: 60_000 }).toBe('paid');
  await rec.caption('The rail settles it: its signed status webhook arrives once and the payout reads Paid. Nothing more posts; a failure would have reversed the journal.');
  const after = await yeshivaBalance(yeshiva);
  expect(after).toBe(start + 1_400_000n);
  await rec.consoleText('The yeshiva, through the staff API (the clock was moved)', [`Balance ILS  ${money(after, 'ILS')}  (${units(after)} agorot)`, '', `Deposit   +${units(2_000_000n)}`, `Payout    −${units(600_000n)}  settled to •••• ${INSTITUTION.payoutIban.slice(-4)}`]);
  await rec.caption(`Booked: ₪20,000.00 in, ₪6,000.00 out to the yeshiva's own account, ${money(after, 'ILS')} left. Exactly the worked example.`);
  await rec.finish();
});

test('REC-14 institution allowance run', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-14', name: 'allowance-run', title: 'The yeshiva pays its students an allowance (money-flows §14)', persona: 'noa', institution: true });
  const yeshiva = await yeshivaId();
  // Recorded alone, the yeshiva starts empty; after REC-13 it holds ₪14,000.00. A run it cannot cover is refused.
  if ((await yeshivaBalance(yeshiva)) < 600_000n) await deposit(yeshiva, 2_000_000n, 'MASAV-REC14-0001');
  const yeshivaBefore = await yeshivaBalance(yeshiva);
  const parties = Object.fromEntries(await Promise.all(STUDENTS.map(async (k) => [k, await partyByPhone(phone(k))] as const)));
  const before = Object.fromEntries(await Promise.all(STUDENTS.map(async (k) => [k, (await customerByApi(parties[k]!)).balances.ILS.available] as const)));
  await signInMember(rec);

  await rec.caption('Noa, Maya and Eli study at the yeshiva. Each accepted the invite their roster row sent and, already verified, is an active member.');
  await signInInstitution(rec, 'rivka');
  await openInstitution(rec, '/allowances/new');
  await rec.institution.getByTestId('schedule-submit').waitFor({ timeout: 120_000 });
  await rec.institution.getByTestId('schedule-name').fill('Weekly pocket money');
  await rec.institution.getByTestId('schedule-amountText').fill('2,000');
  await rec.institution.getByTestId('schedule-cadence').selectOption('weekly');
  await rec.caption('Rivka creates a schedule in Allowances (I07): ₪2,000.00 a member, weekly, every active member. The form shows when it would run.');
  await rec.institution.getByTestId('schedule-submit').click();
  const card = rec.institution.locator('[data-testid^="schedule-"]', { hasText: 'Weekly pocket money' }).first();
  await card.waitFor({ timeout: 120_000 });
  await expect(card).toContainText('Every active member (3)');
  const scheduleId = (await card.getAttribute('data-testid'))!.replace(/^schedule-/, '');

  const date = (await panel.now()).toISOString().slice(0, 10);
  await openInstitution(rec, `/allowances/${scheduleId}`);
  await rec.institution.getByTestId('run-date').fill(date);
  await rec.institution.getByTestId('run-preview').click();
  const total = rec.institution.getByTestId('preview-total');
  await total.waitFor({ timeout: 120_000 });
  expect(minorOf(await total.innerText())).toBe(600_000n);
  const rows = await rec.institution.getByTestId('preview-rows').locator('tbody tr').allInnerTexts();
  expect(rows).toHaveLength(3);
  expect(rows.reduce((n, r) => n + minorOf(r), 0n)).toBe(600_000n);
  await rec.caption(`Preview for ${date}: three members at ₪2,000.00, ₪6,000.00 in all (600,000 agorot). Nothing has moved; the rows add up to the total.`);
  await rec.institution.getByTestId('run-go').click();
  await rec.institution.getByTestId('run-waiting').waitFor({ timeout: 120_000 });
  expect(await yeshivaBalance(yeshiva)).toBe(yeshivaBefore);
  await rec.caption('She runs it with her passkey. ₪6,000.00 is above ₪5,000.00, so the run waits for a second finance member. Her request is the first approval.');

  await signInInstitution(rec, 'shimon');
  await openInstitution(rec, '/allowances');
  const approve = rec.institution.getByTestId(`approve-${scheduleId}-${date}`);
  await approve.waitFor({ timeout: 120_000 });
  await rec.caption('Shimon asks for the same run: the second approval. The run pays each member once, keyed by the run and the member.');
  await approve.click();
  const run = rec.institution.getByTestId(`run-${scheduleId}-${date}`);
  await expect(run.getByTestId('run-status')).toHaveText('Completed', { timeout: 120_000 });
  await expect(run).toContainText('3 paid, 0 failed');

  const after = Object.fromEntries(await Promise.all(STUDENTS.map(async (k) => [k, (await customerByApi(parties[k]!)).balances.ILS.available] as const)));
  for (const k of STUDENTS) expect(after[k]! - before[k]!).toBe(200_000n);
  expect(await yeshivaBalance(yeshiva)).toBe(yeshivaBefore - 600_000n);
  await rec.caption(`Journal allowance, one per member: Dr the yeshiva's account ILS 200,000; Cr the member's wallet ILS 200,000. The yeshiva goes from ${money(yeshivaBefore, 'ILS')} to ${money(yeshivaBefore - 600_000n, 'ILS')}.`);

  for (const k of STUDENTS) {
    if (k !== 'noa') await switchMember(rec, k);
    else await rec.member.getByTestId('home-purse-ILS').waitFor({ timeout: 60_000 });
    await expect.poll(() => homeAvailable(rec, 'ILS'), { timeout: 60_000 }).toBe(after[k]!);
    await rec.caption(`${k[0]!.toUpperCase()}${k.slice(1)}'s Home: the shekel purse shows ${money(after[k]!, 'ILS')}, ${units(200_000n)} agorot more than before the run.`);
  }
  await rec.consoleText('Members and the yeshiva, through the staff API', [...STUDENTS.map((k) => `${k.padEnd(5)} ILS ${money(before[k]!, 'ILS')} → ${money(after[k]!, 'ILS')}  (+${units(200_000n)})`), '', `Yeshiva ILS ${money(yeshivaBefore, 'ILS')} → ${money(yeshivaBefore - 600_000n, 'ILS')}  (−${units(600_000n)})`]);
  await rec.caption('Booked: 600,000 agorot out of the yeshiva, 200,000 into each student. Exactly the worked example.');
  await rec.finish();
});

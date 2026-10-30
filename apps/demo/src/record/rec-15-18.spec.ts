// Recorded walkthroughs REC-15 to REC-18 (T-0923). REC-15 is on the institution variant (T-0927): Rivka bills the
// yeshiva's students in I08 (T-0629), Noa pays by API (Tab 2 has no member fee screen), and I08 shows her receipt
// and exports the month. REC-16 to REC-18 are on the T-0920 harness: an eSIM bought on M26, Ruth closing her account
// on M34 with her card load refunded to its source, and an ACH load the bank returns during its hold, after which
// the nightly balance proof finds the ledger whole. Every amount is asserted against docs/bank-review/money-flows.md
// §15 to §18 in minor units.
import { expect, test } from '@playwright/test';
import { INSTITUTION, PERSONAS } from '../personas.ts';
import { backToHome, customerByApi, fillSteady, homeAvailable, memberApi, minorOf, money, openInstitution, openPath, openRecording, panel, partyByPhone, reopenMember, signInInstitution, signInMember, staffApi, URLS, usd, vendorIdOf } from './flows.ts';

const phone = (key: string) => PERSONAS.find((p) => p.key === key)!.phone;
const units = (minor: bigint): string => minor.toLocaleString('en-US');
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

test.describe.configure({ mode: 'serial' });

/** The yeshiva's shekel balance as Kesher finance reads it. */
async function yeshivaBalance(): Promise<bigint> {
  const { items } = await staffApi<{ items: { id: string; name: string }[] }>('GET', '/admin/institutions');
  const id = items.find((i) => i.name === INSTITUTION.name)!.id;
  const r = await staffApi<{ balances: { minor: string; currency: string }[] }>('GET', `/admin/institutions/${id}/deposits`, { subject: 'staff-finance-1', roles: ['finance'] });
  return BigInt(r.balances.find((b) => b.currency === 'ILS')?.minor ?? '0');
}

test('REC-15 institution collections', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-15', name: 'collections', title: 'A student pays the yeshiva a fee (money-flows §15)', persona: 'noa', institution: true });
  const noa = await partyByPhone(phone('noa'));
  const now = await panel.now();
  const due = isoDate(new Date(now.getTime() + 14 * 86_400_000));
  const before = (await customerByApi(noa)).balances.ILS.available;
  const yeshivaBefore = await yeshivaBalance();
  await signInMember(rec);

  await rec.caption('Rivka, the yeshiva\'s finance lead, bills every active student ₪1,200.00 for the term in Collections (I08).');
  await signInInstitution(rec, 'rivka');
  await openInstitution(rec, '/collections/new');
  await rec.institution.getByTestId('bill-submit').waitFor({ timeout: 120_000 });
  await fillSteady(rec.institution, { 'bill-description': 'Tuition, term 2', 'bill-amountText': '1,200', 'bill-dueDate': due });
  await rec.institution.getByTestId('bill-submit').click();
  const owed = rec.institution.getByTestId('collections-owed');
  await owed.waitFor({ timeout: 120_000 });
  const owedRows = await owed.locator('tr', { hasText: 'Tuition, term 2' }).allInnerTexts();
  expect(owedRows).toHaveLength(3);
  for (const r of owedRows) expect(minorOf(r)).toBe(120_000n);
  await rec.caption(`Noa, Maya and Eli each owe ₪1,200.00 (120,000 agorot), due ${due}. Nothing has moved: a bill is not a payment.`);

  // Tab 2 has no member fee screen, so Noa pays the way the app would, by API, with her passkey.
  const api = await memberApi('noa');
  const { items } = await api.get('/fee-items');
  const fee = items.find((i) => i.description === 'Tuition, term 2' && i.status === 'due');
  if (!fee) throw new Error('Noa has no tuition fee due');
  const receipt = await api.post('/fee-items/{id}/pay', { path: { id: fee.id }, idempotencyKey: `rec15-pay-${fee.id}` });
  expect(BigInt(receipt.amount.minor)).toBe(120_000n);
  expect(receipt.receiptNumber).toMatch(/^KC-\d{6}-[0-9A-F]{12}$/);
  await rec.caption(`API: POST /fee-items/{id}/pay with Noa's passkey step-up (no member fee screen in Tab 2). Receipt ${receipt.receiptNumber}. Journal fee: Dr Noa's wallet ILS 120,000; Cr the yeshiva's account ILS 120,000.`);

  await openInstitution(rec, `/collections?month=${receipt.paidAt.slice(0, 7)}`);
  const paid = rec.institution.getByTestId('collections-paid');
  await paid.waitFor({ timeout: 120_000 });
  await expect(paid).toContainText(receipt.receiptNumber);
  await rec.caption(`I08 shows Noa's payment with its receipt number. Maya and Eli still owe theirs.`);
  await rec.institution.getByTestId('export-csv').click();
  await expect(rec.institution.getByTestId('export-message')).toBeVisible({ timeout: 60_000 });
  await rec.caption(`The month's export, whose totals equal the ledger: "${await rec.institution.getByTestId('export-message').innerText()}"`);

  const after = (await customerByApi(noa)).balances.ILS.available;
  expect(before - after).toBe(120_000n);
  expect((await yeshivaBalance()) - yeshivaBefore).toBe(120_000n);
  await reopenMember(rec);
  await expect.poll(() => homeAvailable(rec, 'ILS'), { timeout: 60_000 }).toBe(after);
  await rec.consoleText('Noa and the yeshiva, through the staff API', [`Noa     ILS ${money(before, 'ILS')} → ${money(after, 'ILS')}  (−${units(120_000n)})`, `Yeshiva ILS ${money(yeshivaBefore, 'ILS')} → ${money(yeshivaBefore + 120_000n, 'ILS')}  (+${units(120_000n)})`]);
  await rec.caption('Booked: 120,000 agorot from Noa\'s purse into the yeshiva\'s account, once, under the fee item\'s key. Exactly the worked example.');
  await rec.finish();
});

test('REC-16 add-on purchase', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-16', name: 'addon-purchase', title: 'An eSIM bought from the club catalogue (money-flows §16)', persona: 'dana' });
  const dana = await partyByPhone(phone('dana'));
  const seen: { order?: { id: string; state: string; price: { minor: string; currency: string } } } = {};
  rec.page.on('response', async (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith('/addon-orders') && r.ok()) seen.order = await r.json();
  });
  await rec.caption('Dana signs in and opens the club\'s eSIM plans (M26). Their prices come from the rule Kesher finance set in A05 (two finance members): 25% on the vendor\'s cost, rounded up to .99.');
  await signInMember(rec);
  const before = await rec.console360(dana, 'Dana before');
  await openPath(rec, '/club/esim');
  const plan = rec.member.locator('[data-testid^="plan-"]').first();
  await plan.waitFor({ timeout: 60_000 });
  await plan.click();
  await rec.member.getByTestId('screen-esim-checkout').waitFor({ timeout: 60_000 });
  await rec.caption('Checkout: the plan\'s price, from her dollar purse; she has no plan credit to apply.');
  await rec.member.getByTestId('esim-buy').click();
  await expect.poll(() => seen.order?.state, { timeout: 60_000 }).toMatch(/charged|fulfilling|fulfilled/);
  const price = BigInt(seen.order!.price.minor);
  await rec.caption(`Bought for ${usd(price)} (${units(price)} cents). Journal addon: Dr Dana's wallet ${units(price)}; Cr addon_payable the vendor's cost; Cr fee_income the rest. The vendor's eSIM follows.`);
  const after = await rec.console360(dana, 'Dana after');
  expect(before.USD.available - after.USD.available).toBe(price);
  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'USD'), { timeout: 30_000 }).toBe(after.USD.available);
  await rec.caption(`Booked: ${units(price)} cents out of Dana's dollar purse, once, under the order's key. A failed fulfilment would reverse the charge.`);
  await rec.finish();
});

test('REC-17 account closure refunds', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-17', name: 'closure-refunds', title: 'Ruth closes her account; her money goes back to its source (money-flows §17)', persona: 'ruth' });
  const ruth = await partyByPhone(phone('ruth'));
  await rec.caption('Ruth loaded $30.00 by card, spent none of it, and has no holds. She closes her account on M34.');
  await signInMember(rec);
  const before = await rec.console360(ruth, 'Ruth before');
  expect([before.USD.available, before.USD.holds]).toEqual([3_000n, 0n]);
  await openPath(rec, '/settings/close');
  const refund = rec.member.getByTestId('close-refund');
  await refund.waitFor({ timeout: 60_000 });
  await rec.caption(`M34 lists what goes back and where: ${await refund.innerText()}.`);
  await refund.click();
  await rec.member.getByTestId('close-closed').waitFor({ timeout: 60_000 });
  await rec.caption('She confirms with her passkey. The refund goes to the card she loaded with; the journal posts only when the provider confirms; then the account closes.');
  const after = await customerByApi(ruth);
  expect([after.balances.USD.available, after.balances.USD.holds, after.balances.ILS.available]).toEqual([0n, 0n, 0n]);
  await rec.consoleText('Ruth, through the staff API', [`USD available ${usd(before.USD.available)} → ${usd(after.balances.USD.available)}  (−${units(3_000n)} cents, refunded to the card)`, `ILS available ${money(after.balances.ILS.available, 'ILS')}`, '', 'Journal refund: Dr Ruth\'s wallet USD 3,000; Cr partner_settlement USD 3,000.']);
  await rec.caption('Booked: 3,000 cents back to the source, every purse at zero, the account closed. Exactly the worked example.');
  await rec.finish();
});

test('REC-18 ledger reversal and the nightly balance proof', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-18', name: 'ledger-reversals', title: 'A reversal is a new journal; the nightly proof checks the ledger (money-flows §18)', persona: 'avi' });
  const avi = await partyByPhone(phone('avi'));
  const seen: { load?: { id: string; state: string } } = {};
  rec.page.on('response', async (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith('/loads') && r.ok()) seen.load = await r.json();
  });
  await rec.caption('Avi adds $50.00 from his bank by ACH. The bank holds it for 3 business days.');
  await signInMember(rec);
  const before = await rec.console360(avi, 'Avi before');
  await rec.member.getByTestId('home-quick-add').click();
  await rec.member.getByTestId('fund-amount').fill('50');
  await rec.member.getByTestId('fund-currency-USD').click();
  await rec.member.getByTestId('fund-purse-USD').click();
  await rec.member.getByTestId('fund-method-ach').click();
  await rec.member.getByTestId('fund-ach-notice').waitFor();
  await rec.member.getByTestId('fund-confirm').click();
  await rec.member.getByTestId('fund-receipt-hold').waitFor({ timeout: 60_000 });
  const held = await rec.console360(avi, 'on hold');
  expect(held.USD.holds - before.USD.holds).toBe(5_000n);
  expect(held.USD.available).toBe(before.USD.available);
  await rec.caption('Journal load_hold: Dr partner_settlement USD 5,000; Cr Avi\'s pending USD 5,000. Nothing is available yet.');

  await rec.caption('Panel: the bank returns the debit during the hold (an ACH return). Its signed webhook reaches the API.');
  const signed = (await panel.hook('funding', 'settle', { loadId: await vendorIdOf(seen.load!.id), status: 'failed' })).result as { headers: Record<string, string>; rawBody: string };
  const hook = await fetch(`${URLS.api}/hooks/funding`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed.headers }, body: signed.rawBody });
  expect(hook.ok).toBe(true);
  const returned = await rec.console360(avi, 'after the return');
  expect([returned.USD.available, returned.USD.holds]).toEqual([before.USD.available, before.USD.holds]);
  await rec.caption('A new journal, kind reversal, posts the hold\'s lines negated: Dr Avi\'s pending USD 5,000; Cr partner_settlement USD 5,000. The first journal stays as it was; nothing is edited.');

  // The same proof the nightly job runs, now, with its per-currency system totals.
  const proof = (await (await fetch(`${URLS.stack}/balance-proof`, { method: 'POST' })).json()) as { ok: boolean; accountsChecked: number; breaks: number; unbalancedJournals: number; systemTotals: Record<string, string> };
  expect(proof).toMatchObject({ ok: true, breaks: 0, unbalancedJournals: 0 });
  expect(Object.values(proof.systemTotals).every((t) => t === '0')).toBe(true);
  await rec.consoleText('The nightly balance proof, run now', [`ok                  ${proof.ok}`, `accounts checked    ${proof.accountsChecked}`, `balance breaks      ${proof.breaks}`, `unbalanced journals ${proof.unbalancedJournals}`, `system totals       ${Object.entries(proof.systemTotals).map(([c, t]) => `${c} ${t}`).join(', ')}`, '', 'Every journal sums to zero per currency, every cached balance equals its postings, and the', 'system total per currency is zero. A break opens a case; the proof never fixes anything itself.']);
  await rec.caption(`The proof finds the ledger whole across ${proof.accountsChecked} accounts. Avi is back where he started: ${usd(returned.USD.available)} available, nothing held.`);
  await rec.finish();
});

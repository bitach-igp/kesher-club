// Recorded walkthroughs REC-01 to REC-05 (T-0920) on the running product: the T-0031 stack, the T-0032
// personas, the member app's web build, the simulator panel and the console. Each asserts that the amounts
// on the member's screen and in Customer 360 equal the worked example in docs/bank-review/money-flows.md, in
// minor units, so a recording cannot pass while showing a wrong number. REC-02 runs last: it moves the
// shared clock days ahead, past what the console's own staff sign-in (signed at real time) accepts.
import { expect, test } from '@playwright/test';
import { PERSONAS } from '../personas.ts';
import { backToHome, cardSpend, reopenMember, customerByApi, homeAvailable, minorOf, openRecording, panel, partyByPhone, signInMember, usd } from './flows.ts';

const phone = (key: string) => PERSONAS.find((p) => p.key === key)!.phone;

test.describe.configure({ mode: 'serial' });

test('REC-01 load by card', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-01', name: 'load-by-card', title: 'Load by card (money-flows §1)', persona: 'dana' });
  const dana = await partyByPhone(phone('dana'));
  await rec.caption('Dana signs in with her passkey. Funder mode needs a funder linked to a member, which the contract cannot make yet (docs/setup/demo.md), so Dana loads her own purse.');
  await signInMember(rec);
  const before = await rec.console360(dana, 'before');
  expect(await homeAvailable(rec, 'USD')).toBe(before.USD.available);

  await rec.caption('P07 Add money: $100.00 by card into the dollar purse. The funding provider (simulator, fixture pm_ok) confirms, and only then does the money land.');
  await rec.member.getByTestId('home-quick-add').click();
  await rec.member.getByTestId('fund-amount').fill('100');
  await rec.member.getByTestId('fund-purse-USD').click();
  await rec.member.getByTestId('fund-method-card').click();
  await rec.member.getByTestId('fund-confirm').click();
  await rec.member.getByTestId('fund-receipt').waitFor({ timeout: 60_000 });
  // Worked example (§1): $100.00 is 10,000 cents, paid and credited.
  const credited = (await rec.member.getByTestId('fund-receipt-credited').innerText());
  await rec.caption(`Receipt: ${credited}. Journal kind load: Dr partner_settlement USD 10,000, Cr member wallet USD 10,000.`);
  expect(credited).toContain('$100.00');

  await rec.member.getByTestId('fund-again').waitFor();
  await rec.page.frameLocator('#member').locator('body').evaluate(() => history.back());
  await rec.member.getByTestId('home-purse-USD').waitFor();
  await expect.poll(() => homeAvailable(rec, 'USD')).toBe(before.USD.available + 10_000n);
  const after = await rec.console360(dana, 'after');
  expect(after.USD.available - before.USD.available).toBe(10_000n);
  await rec.caption(`Booked: Dana's dollar purse is up by exactly 10,000 cents ($100.00) on her Home and in Customer 360.`);
  await rec.finish();
});

/** "3.7" → the exact gross of `minor` at that rate, as a fraction's floor and ceiling in minor units. */
function grossAt(minor: bigint, rate: string): [bigint, bigint] {
  const [whole, frac = ''] = rate.split('.');
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(whole! + frac);
  const floor = (minor * num) / den;
  return [floor, (minor * num) % den === 0n ? floor : floor + 1n];
}

test('REC-03 load into the other purse at the club rate', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-03', name: 'load-other-purse', title: 'Load into the other purse at the club rate (money-flows §3)', persona: 'noa' });
  const noa = await partyByPhone(phone('noa'));
  // What the API priced, as the member app received it: the quote, then the load.
  const seen: { quote?: { total: { minor: string }; markup: { minor: string }; markupBps: number; rate: string; rateVersion?: number }; load?: { credited?: { minor: string; currency: string }; rateVersion?: number } } = {};
  rec.page.on('response', async (r) => {
    if (r.request().method() !== 'POST') return;
    if (r.url().endsWith('/fx/quotes') && r.ok()) seen.quote = await r.json();
    if (r.url().endsWith('/loads') && r.ok()) seen.load = await r.json();
  });
  await rec.caption('Noa, an Israeli member, signs in. She pays $100.00 by card and wants it in her shekel purse.');
  await signInMember(rec);
  const before = await rec.console360(noa, 'before');
  expect(await homeAvailable(rec, 'ILS')).toBe(before.ILS.available);

  await rec.member.getByTestId('home-quick-add').click();
  await rec.member.getByTestId('fund-amount').fill('100');
  await rec.member.getByTestId('fund-currency-USD').click();
  await rec.member.getByTestId('fund-purse-ILS').click();
  await rec.member.getByTestId('fund-method-card').click();
  const quoteCard = rec.member.getByTestId('fund-quote-card');
  if (!(await quoteCard.isVisible())) await rec.member.getByTestId('fund-quote').click();
  await quoteCard.waitFor({ timeout: 30_000 });
  await expect.poll(() => seen.quote !== undefined).toBe(true);
  const q = seen.quote!;
  const lands = minorOf(await quoteCard.innerText());
  const credited = BigInt(q.total.minor);
  const markup = BigInt(q.markup.minor);
  const [lo, hi] = grossAt(10_000n, q.rate);
  // The quote on the screen is the API's, and gross less the plan markup is what lands (ADR-014, decision 2).
  expect(lands).toBe(credited);
  expect(credited + markup >= lo && credited + markup <= hi).toBe(true);
  await rec.caption(`Club rate ${q.rate} (version ${q.rateVersion ?? '—'}): $100.00 is ₪${((credited + markup) / 100n).toString()}.${((credited + markup) % 100n).toString().padStart(2, '0')} gross; the plan's ${q.markupBps} basis points keep ${markup} agorot; ${credited} agorot land.`);

  await rec.member.getByTestId('fund-confirm').click();
  await rec.member.getByTestId('fund-receipt').waitFor({ timeout: 60_000 });
  const receipt = minorOf(await rec.member.getByTestId('fund-receipt-credited').innerText());
  expect(receipt).toBe(credited);
  expect(BigInt(seen.load!.credited!.minor)).toBe(credited);
  await rec.caption(`Receipt: ${await rec.member.getByTestId('fund-receipt-credited').innerText()}, priced once when the load began. Journal kind load: Dr partner_settlement USD 10,000; fx_position both sides; Cr wallet ILS ${credited}; Cr fee_income ILS ${markup}.`);

  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'ILS')).toBe(before.ILS.available + credited);
  const after = await rec.console360(noa, 'after');
  expect(after.ILS.available - before.ILS.available).toBe(credited);
  expect(after.USD.available).toBe(before.USD.available);
  await rec.caption(`Booked: the shekel purse is up by exactly ${credited} agorot on Noa's Home and in Customer 360; the dollar purse did not move.`);
  await rec.finish();
});

test('REC-04 auto-reload', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-04', name: 'auto-reload', title: 'Auto-reload (money-flows §4)', persona: 'tamar' });
  const tamar = await partyByPhone(phone('tamar'));
  await rec.caption('Tamar signs in. Her dollar purse holds $200.00 and her virtual card is active.');
  await signInMember(rec);
  const before = await rec.console360(tamar, 'before');
  expect(before.USD.available).toBe(20_000n);

  await rec.caption('P07 Auto-reload: below $50.00, top the dollar purse back up to $200.00 from the saved card. Saving needs a fresh passkey step-up.');
  await rec.member.getByTestId('home-quick-add').click();
  await rec.member.getByTestId('fund-auto-reload').click();
  await rec.member.getByTestId('screen-auto-reload').waitFor();
  await rec.member.getByTestId('reload-purse-USD').click();
  await rec.member.getByTestId('reload-threshold').fill('50');
  await rec.member.getByTestId('reload-target').fill('200');
  await rec.member.getByTestId('reload-method-card').click();
  await rec.member.getByTestId('reload-pm-pm_ok').click();
  await rec.member.getByTestId('reload-save').click();
  await rec.member.getByTestId('reload-notice').waitFor({ timeout: 60_000 });
  await expect(rec.member.getByTestId('reload-status')).toHaveText(/on/i);

  await rec.caption('Panel: Tamar taps her card at a café for $155.00. The processor asks the API (JIT), which approves and holds it. Available falls to $45.00, below the threshold.');
  expect((await cardSpend(tamar, 15_500n)).result).toBe('APPROVED');
  const spent = await customerByApi(tamar);
  expect(spent.balances.USD.available).toBe(4_500n);

  await rec.caption('Panel: the auto-reload job runs now instead of waiting for its 15-minute timer. It loads target less available, once in 24 hours.');
  await panel.runJob('auto-reload');
  await panel.runJob('auto-reload');
  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'USD'), { timeout: 30_000 }).toBe(20_000n);
  const after = await rec.console360(tamar, 'after');
  // Worked example (§4): $45.00 available, threshold $50.00, target $200.00, loads $155.00 (15,500 cents) once.
  expect(after.USD.available - spent.balances.USD.available).toBe(15_500n);
  expect(after.USD.available).toBe(20_000n);
  await rec.caption(`Booked: one load of ${usd(15_500n)} (15,500 cents); the second run of the job loaded nothing. Available is back to ${usd(after.USD.available)}, the café's $155.00 still on hold.`);
  await rec.finish();
});

test('REC-05 P2P send', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-05', name: 'p2p-send', title: 'P2P send, same currency (money-flows §5)', persona: 'dana' });
  const [dana, avi] = [await partyByPhone(phone('dana')), await partyByPhone(phone('avi'))];
  await rec.caption('Dana signs in to pay Avi $25.00: under the $150.00 new-counterparty hold, within a new member\'s $300.00 monthly limit.');
  await signInMember(rec);
  const before = { dana: (await customerByApi(dana)).balances, avi: (await customerByApi(avi)).balances };
  await rec.console360(avi, 'Avi before');

  await rec.member.getByTestId('home-quick-send').click();
  await rec.caption('M13: the recipient is Avi\'s member id. The server resolves and verifies him; the screen trusts nothing it was told.');
  await rec.member.getByTestId('recipient-input').fill(avi);
  await rec.member.getByTestId('recipient-continue').click();
  await rec.member.getByTestId('amount-purse-USD').click();
  await rec.member.getByTestId('amount-input').fill('25');
  await rec.member.getByTestId('amount-continue').click();
  await rec.caption('M15: one Idempotency-Key for this sheet, kept through the passkey step-up, so a double tap is one transfer.');
  await rec.member.getByTestId('confirm-send').click();
  await rec.member.getByTestId('confirm-notice').waitFor({ timeout: 60_000 });

  const after = { dana: (await customerByApi(dana)).balances, avi: (await customerByApi(avi)).balances };
  // Journal kind p2p: Dr Dana's wallet 2,500 cents, Cr Avi's wallet 2,500 cents.
  expect(before.dana.USD.available - after.dana.USD.available).toBe(2_500n);
  expect(after.avi.USD.available - before.avi.USD.available).toBe(2_500n);
  await rec.console360(avi, 'Avi after');
  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'USD')).toBe(after.dana.USD.available);
  await rec.caption(`Booked: journal kind p2p, Dr Dana's wallet 2,500 cents, Cr Avi's wallet 2,500 cents. Dana's purse ${usd(after.dana.USD.available)} on her Home; Avi's ${usd(after.avi.USD.available)} in Customer 360.`);
  await rec.finish();
});

test('REC-02 ACH load with bank hold and release', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-02', name: 'ach-hold-release', title: 'ACH load with bank hold and release (money-flows §2)', persona: 'dana' });
  const dana = await partyByPhone(phone('dana'));
  await rec.caption('Dana signs in and adds $100.00 from her bank by ACH.');
  await signInMember(rec);
  const before = await rec.console360(dana, 'before');

  await rec.member.getByTestId('home-quick-add').click();
  await rec.member.getByTestId('fund-amount').fill('100');
  await rec.member.getByTestId('fund-currency-USD').click();
  await rec.member.getByTestId('fund-purse-USD').click();
  await rec.member.getByTestId('fund-method-ach').click();
  await rec.member.getByTestId('fund-ach-notice').waitFor();
  await rec.member.getByTestId('fund-confirm').click();
  await rec.member.getByTestId('fund-receipt-hold').waitFor({ timeout: 60_000 });
  const hold = await rec.member.getByTestId('fund-receipt-hold').innerText();
  await rec.caption(`The bank holds it: "${hold}". Journal kind load_hold: Dr partner_settlement 10,000 cents, Cr Dana's pending 10,000 cents.`);
  const held = await rec.console360(dana, 'on hold');
  expect(held.USD.holds - before.USD.holds).toBe(10_000n);
  expect(held.USD.available).toBe(before.USD.available);

  await rec.caption('Panel: the clock moves 5 days, past 3 business days whatever the weekday, and the release job runs now instead of on its 5-minute timer.');
  const moved = await panel.advance(5 * 86_400_000);
  await rec.refreshPanel();
  await panel.runJob('ach-release-holds');
  const released = await customerByApi(dana);
  expect(released.balances.USD.available - before.USD.available).toBe(10_000n);
  expect(released.balances.USD.holds).toBe(before.USD.holds);
  await rec.consoleText(`Customer 360 through the staff API, at ${moved.now}`, [
    `USD available ${usd(released.balances.USD.available)} (before ${usd(before.USD.available)}, +10,000 cents)`,
    `USD holds     ${usd(released.balances.USD.holds)} (back to before)`,
    '',
    'The console signs its staff tokens at real time; the API now runs 5 days ahead, so this read is the',
    'same Customer 360 endpoint called with a token signed at the API\'s clock.',
  ]);
  await rec.caption('Five days later Dana opens the app again and signs in.');
  await reopenMember(rec);
  await expect.poll(() => homeAvailable(rec, 'USD'), { timeout: 30_000 }).toBe(released.balances.USD.available);
  await rec.caption(`Released: journal kind load_release, Dr pending 10,000 cents, Cr wallet 10,000 cents. Dana's Home shows ${usd(released.balances.USD.available)}.`);
  await rec.finish();
});


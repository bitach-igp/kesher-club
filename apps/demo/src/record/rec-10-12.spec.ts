// Recorded walkthroughs REC-10 to REC-12 (T-0922) on the T-0920 harness: a conversion between a member's own
// purses, the club rate (published by the job, then a two-person manual rate) and the quote that follows it, and
// a card authorisation at a till with the hold it leaves and a decline that leaves none. Each asserts that the
// amounts on the member's screen and in Customer 360 equal docs/bank-review/money-flows.md, in minor units. The
// FX simulator's mid rate is 3.71 ILS per USD, the worked example's rate.
import { applyBps, money as m } from '@kesher/domain';
import { expect, test } from '@playwright/test';
import { PERSONAS } from '../personas.ts';
import { backToHome, cardSpend, homeAvailable, minorOf, money, openPath, openRecording, panel, partyByPhone, signInMember, staffApi, type Recording } from './flows.ts';

const phone = (key: string) => PERSONAS.find((p) => p.key === key)!.phone;
const units = (minor: bigint): string => minor.toLocaleString('en-US');
type Quote = { from: { minor: string; currency: string }; total: { minor: string; currency: string }; markup: { minor: string }; markupBps: number; rate: string; rateVersion?: number };

test.describe.configure({ mode: 'serial' });

/** Opens M18 convert and asks for a $100.00 quote out of the dollar purse; answers the quote the API priced. */
async function quoteHundredDollars(rec: Recording, seen: { quote?: Quote | undefined }): Promise<Quote> {
  await openPath(rec, '/convert');
  await rec.member.getByTestId('screen-convert').waitFor({ timeout: 30_000 });
  for (let attempt = 0; attempt < 2; attempt++) {
    seen.quote = undefined;
    await rec.member.getByTestId('fx-amount').fill('100');
    await rec.member.getByTestId('fx-quote').click();
    await expect.poll(() => seen.quote !== undefined, { timeout: 30_000 }).toBe(true);
    if (seen.quote!.from.currency === 'USD') return seen.quote!;
    await rec.member.getByTestId('fx-swap').click(); // it opened on the shekel purse: turn it round
  }
  throw new Error('The convert screen never quoted out of the dollar purse');
}

test('REC-10 FX conversion between purses', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-10', name: 'fx-conversion', title: 'FX conversion between purses (money-flows §10)', persona: 'noa' });
  const noa = await partyByPhone(phone('noa'));
  const seen: { quote?: Quote | undefined; converted?: { state: string } } = {};
  rec.page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !r.ok()) return;
    if (r.url().endsWith('/fx/quotes')) seen.quote = (await r.json()) as Quote;
    else if (r.url().endsWith('/fx/conversions')) seen.converted = await r.json();
  });
  await rec.caption('Noa holds dollars and shekels. She converts $100.00 into shekels on M18, at a quote that holds for 30 seconds.');
  await signInMember(rec);
  const before = await rec.console360(noa, 'Noa before');
  const q = await quoteHundredDollars(rec, seen);
  // money-flows §10: $100.00 at 3.71 is ₪371.00 gross; 75 basis points take ₪2.78; Noa receives ₪368.22.
  expect([q.rate, BigInt(q.total.minor), BigInt(q.markup.minor), q.markupBps]).toEqual(['3.710000', 36_822n, 278n, 75]);
  expect(applyBps(m(37_100n, 'ILS'), 75n).minor).toBe(278n);
  expect(minorOf(await rec.member.getByTestId('fx-quote-card').innerText())).toBe(36_822n);
  await rec.caption(`Quote: rate ${q.rate}. $100.00 is ₪371.00 gross (37,100 agorot); 75 basis points keep ${units(278n)} agorot; Noa receives ${money(36_822n, 'ILS')}. Exactly the worked example.`);
  await rec.member.getByTestId('fx-confirm').click();
  await rec.member.getByTestId('fx-notice').waitFor({ timeout: 60_000 });
  await rec.caption(`Converted with her passkey. Journal kind fx: Dr Noa's wallet USD 10,000; Cr fx_position USD 10,000; Dr fx_position ILS 37,100; Cr Noa's wallet ILS 36,822; Cr fee_income ILS 278.`);
  const after = await rec.console360(noa, 'Noa after');
  expect(before.USD.available - after.USD.available).toBe(10_000n);
  expect(after.ILS.available - before.ILS.available).toBe(36_822n);
  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'ILS')).toBe(after.ILS.available);
  await rec.caption('Booked: 10,000 cents out of her dollar purse, 36,822 agorot into her shekel purse, in Customer 360 and on her Home.');
  await rec.finish();
});

test('REC-11 club rates: published, then a two-person manual rate', async ({ browser }) => {
  // Dana, not Noa: REC-10 converted Noa's only $100.00.
  const rec = await openRecording(browser, { id: 'REC-11', name: 'club-rates', title: 'Club rates: the published rate and a two-person manual rate (money-flows §11)', persona: 'dana' });
  const seen: { quote?: Quote | undefined } = {};
  rec.page.on('response', async (r) => {
    if (r.request().method() === 'POST' && r.ok() && r.url().endsWith('/fx/quotes')) seen.quote = (await r.json()) as Quote;
  });
  type Rate = { id: string; version: number; mid: string; source: string; status: string };
  const rates = async () => (await staffApi<{ items: Rate[] }>('GET', '/admin/fx/rates', { subject: 'staff-finance-1', roles: ['finance'] })).items;
  const line = (r: Rate) => `v${r.version}  ${r.mid}  ${r.source}  ${r.status}`;

  await rec.caption('The worker publishes the FX provider\'s mid-rate every 5 minutes. The panel runs that job now.');
  await panel.runJob('fx-refresh-rates');
  const published = (await rates()).find((r) => r.status === 'active')!;
  expect([published.mid, published.source]).toEqual(['3.710000', 'port']);
  await rec.consoleText('Club rates, USD/ILS (staff API: GET /admin/fx/rates)', (await rates()).slice(0, 5).map(line));
  await signInMember(rec);
  const first = await quoteHundredDollars(rec, seen);
  expect(first.rate).toBe(published.mid);
  await rec.caption(`Dana's quote prices from the published rate: ${first.rate}, so $100.00 gives ${money(BigInt(first.total.minor), 'ILS')}.`);

  await rec.caption('Finance sets a manual rate of 3.6500 with a reason (API: POST /admin/fx/rates as Finn). It does nothing until a second, different finance member approves.');
  const proposed = await staffApi<Rate>('POST', '/admin/fx/rates', { subject: 'staff-finance-1', roles: ['finance'], body: { pair: 'USD/ILS', mid: '3.6500', reason: 'Recording REC-11: provider rate under review' } });
  expect(proposed.status).not.toBe('active');
  await rec.consoleText('Club rates after Finn\'s proposal', (await rates()).slice(0, 5).map(line));
  await expect(staffApi('POST', `/admin/fx/rates/${proposed.id}/approve`, { subject: 'staff-finance-1', roles: ['finance'] })).rejects.toThrow();
  await rec.caption('Finn cannot approve his own rate. Fern, a second finance member, approves it (API: POST /admin/fx/rates/{id}/approve as Fern).');
  const active = await staffApi<Rate>('POST', `/admin/fx/rates/${proposed.id}/approve`, { subject: 'staff-finance-2', roles: ['finance'] });
  expect([active.status, active.mid, active.source]).toEqual(['active', '3.650000', 'manual']);
  await rec.consoleText('Club rates after Fern\'s approval: the manual rate is active, and the worker publishes nothing while it is', (await rates()).slice(0, 5).map(line));

  const second = await quoteHundredDollars(rec, seen);
  // $100.00 at 3.65 is ₪365.00 gross; 75 basis points of 36,500 is 273.75, rounded half up to 274; Noa receives 36,226.
  expect([second.rate, BigInt(second.total.minor), BigInt(second.markup.minor)]).toEqual(['3.650000', 36_226n, 274n]);
  await rec.caption(`The next quote uses the manual rate: ${second.rate}. $100.00 is ₪365.00 gross; 75 basis points keep 274 agorot; Dana would receive ${money(36_226n, 'ILS')}. She does not convert.`);
  await rec.finish();
});

test('REC-12 card authorisation and its hold', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-12', name: 'card-authorisation', title: 'Card authorisation at a till, and the hold it leaves (money-flows §12)', persona: 'tamar' });
  const tamar = await partyByPhone(phone('tamar'));
  await rec.caption('Tamar, a US member with an active virtual card, has dollars only. She taps her card for $18.00 at Cofix in Israel: the panel sends the processor\'s signed request.');
  await signInMember(rec);
  const before = await rec.console360(tamar, 'Tamar before');
  const approved = await cardSpend(tamar, 1_800n);
  expect(approved.result).toBe('approved');
  await rec.caption('Approved inside the time budget. In Israel the shekel purse pays first, but hers is empty, so the dollar purse pays the $18.00 in its own currency. Journal kind auth_hold: Dr Tamar\'s wallet USD 1,800; Cr Tamar\'s pending USD 1,800.');
  const held = await rec.console360(tamar, 'Tamar after the tap');
  expect([before.USD.available - held.USD.available, held.USD.holds - before.USD.holds]).toEqual([1_800n, 1_800n]);
  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'USD')).toBe(held.USD.available);
  const holdRow = rec.member.getByTestId('home-holds-USD');
  await holdRow.waitFor({ timeout: 30_000 });
  expect(minorOf(await holdRow.innerText())).toBe(held.USD.holds);
  await rec.caption(`Her Home shows ${money(held.USD.available, 'USD')} available and ${money(held.USD.holds, 'USD')} on hold, as Customer 360 does.`);

  const tooMuch = held.USD.available + 100n;
  const declined = await cardSpend(tamar, tooMuch);
  expect(declined).toMatchObject({ result: 'declined', reason: 'INSUFFICIENT_FUNDS' });
  await rec.caption(`A second tap for ${money(tooMuch, 'USD')}, a dollar more than she has, is declined: INSUFFICIENT_FUNDS. A decline holds nothing.`);
  const after = await rec.console360(tamar, 'Tamar after the decline');
  expect([after.USD.available, after.USD.holds]).toEqual([held.USD.available, held.USD.holds]);
  await rec.caption('Booked: one hold of 1,800 cents, and nothing from the decline.');
  await rec.finish();
});

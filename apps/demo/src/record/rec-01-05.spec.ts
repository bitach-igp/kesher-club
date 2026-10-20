// Recorded walkthroughs REC-01 to REC-05 (T-0920) on the running product: the T-0031 stack, the T-0032
// personas, the member app's web build, the simulator panel and the console. Each asserts that the amounts
// on the member's screen and in Customer 360 equal the worked example in docs/bank-review/money-flows.md, in
// minor units, so a recording cannot pass while showing a wrong number.
import { expect, test } from '@playwright/test';
import { PERSONAS } from '../personas.ts';
import { homeAvailable, openRecording, partyByPhone, signInMember } from './flows.ts';

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

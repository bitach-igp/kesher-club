// Recorded walkthroughs REC-06 to REC-09 (T-0921) on the T-0920 harness: the pay screens for a send across
// currencies, a split and its payment from the inbox, a send proposed by an assistant and approved on the
// proposal screen, and the new-pair hold with its cancel and its release. Each asserts that the amounts on
// the member's screen and in Customer 360 equal the worked example in docs/bank-review/money-flows.md, in
// minor units. REC-06 runs last: it moves the shared clock, past what the console's own sign-in accepts.
import { applyBps, money as m } from '@kesher/domain';
import { expect, test } from '@playwright/test';
import { PERSONAS } from '../personas.ts';
import { assistantPropose, backToHome, customerByApi, homeAvailable, minorOf, money, openPath, openRecording, panel, partyByPhone, reopenMember, sendFromHome, signInMember, switchMember } from './flows.ts';

const phone = (key: string) => PERSONAS.find((p) => p.key === key)!.phone;

test.describe.configure({ mode: 'serial' });

test('REC-07 P2P send across currencies', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-07', name: 'p2p-cross-currency', title: 'P2P send across currencies (money-flows §7)', persona: 'noa' });
  const [dana, noa] = [await partyByPhone(phone('dana')), await partyByPhone(phone('noa'))];
  // What the API priced, as the member app received it: the preview, then the send.
  const seen: { preview?: { amount: { minor: string }; received: { minor: string; currency: string }; rate?: string; rateVersion?: number }; sent?: { state: string; amount: { minor: string }; received?: { minor: string; currency: string } } } = {};
  rec.page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !r.ok()) return;
    if (r.url().endsWith('/transfers/preview')) seen.preview = await r.json();
    else if (r.url().endsWith('/transfers')) seen.sent = await r.json();
  });

  await rec.caption('Noa, an Israeli member, signs in and chooses to receive in shekels (M33). Nothing in the app links to M33 yet, so the recorder opens its address inside the app.');
  await signInMember(rec);
  await openPath(rec, '/settings/currency');
  await rec.member.getByTestId('screen-currency').waitFor();
  await rec.member.getByTestId('currency-ILS').click();
  await rec.member.getByTestId('currency-notice').waitFor({ timeout: 30_000 });
  const noaBefore = await rec.console360(noa, 'Noa before');

  await rec.caption('The member pane signs in as Dana, in the US. She sends Noa $100.00 from her dollar purse.');
  await switchMember(rec, 'dana');
  const danaBefore = (await customerByApi(dana)).balances;
  await sendFromHome(rec, noa, 'USD', '100');
  const receives = rec.member.getByTestId('confirm-receives');
  await receives.waitFor({ timeout: 30_000 });
  await expect.poll(() => seen.preview !== undefined).toBe(true);
  const p = seen.preview!;
  const received = BigInt(p.received.minor);
  expect(p.received.currency).toBe('ILS');
  expect(minorOf(await receives.innerText())).toBe(received);
  // Gross at the club rate less Noa's plan markup (75 basis points without a plan), rounded half up.
  const gross = grossFor(10_000n, p.rate!, received);
  const markup = gross - received;
  expect(applyBps(m(gross, 'ILS'), 75n).minor).toBe(markup);
  await rec.caption(`M15: Noa receives ${money(received, 'ILS')}. Club rate ${p.rate} (version ${p.rateVersion ?? '—'}): $100.00 is ${money(gross, 'ILS')} gross; Noa's 75 basis points keep ${markup} agorot.`);

  await rec.member.getByTestId('confirm-send').click();
  await rec.member.getByTestId('confirm-both').waitFor({ timeout: 60_000 });
  expect(BigInt(seen.sent!.received!.minor)).toBe(received);
  await rec.caption(`Sent at the price fixed when it began: ${await rec.member.getByTestId('confirm-both').innerText().then((t) => t.replace(/\s+/g, ' '))}. Journal kind p2p: Dr Dana's wallet USD 10,000; fx_position both sides; Cr Noa's wallet ILS ${received}; Cr fee_income ILS ${markup}.`);

  const danaAfter = (await customerByApi(dana)).balances;
  expect(danaBefore.USD.available - danaAfter.USD.available).toBe(10_000n);
  const noaAfter = await rec.console360(noa, 'Noa after');
  expect(noaAfter.ILS.available - noaBefore.ILS.available).toBe(received);
  expect(noaAfter.USD.available).toBe(noaBefore.USD.available);
  await backToHome(rec);
  await expect.poll(() => homeAvailable(rec, 'USD')).toBe(danaAfter.USD.available);
  await rec.caption(`Booked: Dana's dollar purse is down 10,000 cents on her Home; Noa's shekel purse is up exactly ${received} agorot in Customer 360, her dollar purse unchanged.`);
  await rec.finish();
});

test('REC-08 payment requests and splits', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-08', name: 'requests-splits', title: 'Payment requests and splits (money-flows §8)', persona: 'noa' });
  const [noa, maya, eli, avi] = [await partyByPhone(phone('noa')), await partyByPhone(phone('maya')), await partyByPhone(phone('eli')), await partyByPhone(phone('avi'))];
  await rec.caption('Noa splits a ₪200.00 dinner four ways (M17) with Maya, Eli and Avi, by their member ids.');
  await signInMember(rec);
  const noaBefore = (await customerByApi(noa)).balances;
  await rec.member.getByTestId('home-quick-send').click();
  await rec.member.getByTestId('screen-pay').waitFor();
  await rec.member.getByTestId('pay-split').click();
  await rec.member.getByTestId('split-total').fill('200');
  for (const id of [maya, eli, avi]) {
    await rec.member.getByTestId('split-add').fill(id);
    await rec.member.getByTestId('split-add').press('Enter');
  }
  // Worked example (§8): ₪200.00 four ways is three requests of ₪50.00 (5,000 agorot); Noa covers the rest.
  await expect(rec.member.getByTestId('split-preview')).toContainText('₪50.00');
  await rec.member.getByTestId('split-create').click();
  await expect(rec.member.getByTestId('split-notice')).toContainText('3');
  await rec.caption('Three requests of ₪50.00 (5,000 agorot) each; Noa keeps her own ₪50.00 share. Nothing posts until someone pays.');
  expect((await customerByApi(noa)).balances).toEqual(noaBefore);

  await rec.caption('The member pane signs in as Maya. Her inbox (M18) shows what she owes Noa; she pays it.');
  await switchMember(rec, 'maya');
  const mayaBefore = await rec.console360(maya, 'Maya before');
  await rec.member.getByTestId('home-quick-send').click();
  await rec.member.getByTestId('pay-inbox').click();
  const owed = rec.member.locator('[data-testid^="inbox-owed-"]').first();
  await owed.waitFor({ timeout: 30_000 });
  expect(minorOf(await owed.innerText())).toBe(5_000n);
  await rec.member.locator('[data-testid^="inbox-pay-"]').first().click();
  await rec.member.getByTestId('inbox-notice').waitFor({ timeout: 60_000 });
  await expect(rec.member.locator('[data-testid^="inbox-pay-"]')).toHaveCount(0);

  const mayaAfter = await rec.console360(maya, 'Maya after');
  const noaAfter = (await customerByApi(noa)).balances;
  expect(mayaBefore.ILS.available - mayaAfter.ILS.available).toBe(5_000n);
  expect(noaAfter.ILS.available - noaBefore.ILS.available).toBe(5_000n);
  await rec.caption(`Paid as an ordinary send keyed request:{id}:pay. Journal kind p2p: Dr Maya's wallet ILS 5,000, Cr Noa's wallet ILS 5,000. Maya's purse ${money(mayaAfter.ILS.available, 'ILS')}; Eli's and Avi's requests stay open.`);
  await rec.finish();
});

test('REC-09 send proposed by an assistant', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-09', name: 'assistant-send', title: 'Send proposed by an AI assistant (money-flows §9)', persona: 'dana' });
  const [dana, avi] = [await partyByPhone(phone('dana')), await partyByPhone(phone('avi'))];
  const before = { dana: (await customerByApi(dana)).balances, avi: (await customerByApi(avi)).balances };
  const proposed = await assistantPropose({ partyId: dana, toPartyId: avi, amount: { minor: '2000', currency: 'USD' }, note: 'Lunch money, as you asked' });
  await rec.caption(`Assistant: ${proposed.assistant}, connected to Dana's account, proposes paying Avi $20.00 (propose_p2p). It is a pending intent: no transfer and no journal until Dana approves. The MCP gateway is not mounted in the running API yet, so the recording stack makes the tool's call.`);
  expect((await customerByApi(dana)).balances).toEqual(before.dana);

  await rec.caption('Dana signs in. Home shows the proposal waiting; she opens it.');
  await signInMember(rec);
  await rec.member.getByTestId('home-proposals').waitFor({ timeout: 30_000 });
  await rec.member.getByTestId('home-proposals').getByText('Review').click();
  await rec.member.locator(`[data-testid="proposal-row-${proposed.intentId}"]`).click();
  await rec.member.getByTestId('proposal-sentence').waitFor();
  const sentence = (await rec.member.getByTestId('proposal-sentence').innerText()).replace(/\s+/g, ' ');
  expect(minorOf(sentence)).toBe(2_000n);
  await rec.caption(`The proposal, in Kesher's words: "${sentence}". Only Dana, with a passkey step-up, can approve it, within 24 hours.`);

  await rec.member.getByTestId('proposal-approve').click();
  await rec.member.getByTestId('proposal-done').waitFor({ timeout: 60_000 });
  await expect(rec.member.getByTestId('proposal-approve')).toHaveCount(0);
  const after = { dana: (await customerByApi(dana)).balances, avi: await rec.console360(avi, 'Avi after') };
  expect(before.dana.USD.available - after.dana.USD.available).toBe(2_000n);
  expect(after.avi.USD.available - before.avi.USD.available).toBe(2_000n);
  await rec.caption(`Approved: Dana's own send ran, keyed intent:{id}. Journal kind p2p: Dr Dana's wallet USD 2,000, Cr Avi's wallet USD 2,000. Avi's purse ${money(after.avi.USD.available, 'USD')} in Customer 360.`);
  await rec.finish();
});

test('REC-06 P2P new-pair hold, cancel and release', async ({ browser }) => {
  const rec = await openRecording(browser, { id: 'REC-06', name: 'p2p-new-pair-hold', title: 'P2P new-counterparty hold, cancel and release (money-flows §6)', persona: 'maya' });
  const [maya, eli] = [await partyByPhone(phone('maya')), await partyByPhone(phone('eli'))];
  await rec.caption('Maya has never paid Eli. She sends him ₪600.00, above the ₪500.00 new-pair threshold.');
  await signInMember(rec);
  const before = await rec.console360(maya, 'Maya before');
  const eliBefore = (await customerByApi(eli)).balances;

  await sendFromHome(rec, eli, 'ILS', '600');
  await rec.member.getByTestId('confirm-send').click();
  await rec.member.getByTestId('confirm-hold').waitFor({ timeout: 60_000 });
  await rec.caption(`Held for two hours: "${await rec.member.getByTestId('confirm-hold').innerText()}". Journal kind p2p_hold: Dr Maya's wallet ILS 60,000, Cr Maya's pending ILS 60,000.`);
  const held = await rec.console360(maya, 'held');
  expect(before.ILS.available - held.ILS.available).toBe(60_000n);
  expect(held.ILS.holds - before.ILS.holds).toBe(60_000n);

  await rec.caption('Maya cancels while it waits. The hold journal is reversed: the money is back in her purse and Eli gets nothing.');
  await rec.member.getByTestId('confirm-cancel-hold').click();
  await rec.member.getByTestId('confirm-notice').waitFor({ timeout: 60_000 });
  const cancelled = await rec.console360(maya, 'cancelled');
  expect(cancelled.ILS).toEqual(before.ILS);
  expect((await customerByApi(eli)).balances.ILS).toEqual(eliBefore.ILS);

  await rec.caption('She sends it again. Still a new pair (no settled send to Eli), so it is held again.');
  await backToHome(rec);
  await sendFromHome(rec, eli, 'ILS', '600');
  await rec.member.getByTestId('confirm-send').click();
  await rec.member.getByTestId('confirm-hold').waitFor({ timeout: 60_000 });

  await rec.caption('Panel: the clock moves two hours and a minute, and the release job runs now instead of on its one-minute timer.');
  const moved = await panel.advance(2 * 3_600_000 + 60_000);
  await rec.refreshPanel();
  await panel.runJob('p2p-release-holds');
  const released = { maya: await rec.console360(maya, 'released'), eli: (await customerByApi(eli)).balances };
  expect(before.ILS.available - released.maya.ILS.available).toBe(60_000n);
  expect(released.maya.ILS.holds).toBe(before.ILS.holds);
  expect(released.eli.ILS.available - eliBefore.ILS.available).toBe(60_000n);
  await reopenMember(rec);
  await expect.poll(() => homeAvailable(rec, 'ILS')).toBe(released.maya.ILS.available);
  await rec.caption(`Released at ${moved.now}. Journal kind p2p_release: Dr Maya's pending ILS 60,000, Cr Eli's wallet ILS 60,000. Eli ${money(released.eli.ILS.available, 'ILS')}; Maya ${money(released.maya.ILS.available, 'ILS')} on her Home.`);
  await rec.finish();
});

/**
 * The gross at the quoted club rate that, less 75 basis points, leaves `received`: the rate on the wire is
 * a decimal for display, so the gross is the floor or the ceiling of amount × rate.
 */
function grossFor(minor: bigint, rate: string, received: bigint): bigint {
  const [whole, frac = ''] = rate.split('.');
  const den = 10n ** BigInt(frac.length);
  const floor = (minor * BigInt(whole! + frac)) / den;
  const candidates = [floor, floor + 1n];
  const hit = candidates.find((g) => g - applyBps(m(g, 'ILS'), 75n).minor === received);
  expect(hit, `no gross of ${candidates.join(' or ')} leaves ${received} after 75 bp`).toBeDefined();
  return hit!;
}

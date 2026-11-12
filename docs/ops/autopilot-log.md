# Autopilot log

One line per merge: date, card, PR, reviewer verdict, CI. Newest last. See `.claude/skills/club-autopilot`.

Snapshot as of 2026-11-04 (will go stale; the table below is the record): main at fe33632, Crowded cards T-0647..T-0655 merged.
Queue: T-0659, T-0660, review-fixes cards (T-0539, T-0540, T-0542, T-0543, T-0546, T-0541, T-0544, T-0312,
T-0658, T-1018, T-0657). T-0545: take the card's default (refuse member payouts above the two-person
threshold with VALIDATION_FAILED); no finance approval route. T-0659 keeps CROWDED_BINDING=live (warns).

| Date | Card | PR | Reviewer | CI |
|---|---|---|---|---|
| 2026-11-04 | T-0659 | #193 | Opus APPROVE (after 1 fix round) | green |
| 2026-11-04 | T-0660 | #195 | Opus APPROVE (after 1 fix round) | green |
| 2026-11-04 | T-0656 | #197 | Sonnet APPROVE (2 fix rounds, docs) | green |
| 2026-11-04 | T-0542 | #198 | Opus APPROVE | green |
| 2026-11-04 | T-0539 | #196 | Opus APPROVE (4 review rounds; owner: push through) | green |
| 2026-11-04 | T-0540 | #199 | Opus APPROVE (1 fix round) | green |
| 2026-11-04 | T-0543 | #200 | Opus APPROVE (1 fix round) | green |
| 2026-11-04 | T-0546 | #201 | Opus APPROVE (1 fix round) | green |
| 2026-11-04 | T-0541 | #202 | Opus APPROVE (1 fix round) | green |
| 2026-11-04 | T-0544 | #203 | Sonnet APPROVE (1 fix round; Sonnet by the user's throttle request), desktop PASS | green |
| 2026-11-04 | T-0658 | #205 | Sonnet APPROVE (first round) | green |
| 2026-11-05 | T-1018 | #207 | Sonnet APPROVE (1 fix round) | green |
| 2026-11-05 | T-0312 | #208 | Sonnet APPROVE (documented displacement race, follow-up queued) | green |
| 2026-11-05 | T-0545 | #209 | Sonnet APPROVE (first round) | green |
| 2026-11-05 | T-0313 | #211 | Sonnet APPROVE (1 fix round), desktop PASS | green |
| 2026-11-05 | T-0547 | #212 | Sonnet APPROVE (1 fix round; reopen-the-case gap noted) | green |
| 2026-11-05 | T-0548 | #213 | Sonnet APPROVE (2 fix rounds) | green |
| 2026-11-05 | T-0549 | #214 | Sonnet APPROVE (first round) | green |
| 2026-11-05 | T-0551 | #215 | Sonnet APPROVE (first round) | green |
| 2026-11-05 | T-0553 | #216 | Sonnet APPROVE (first round) | green |
| 2026-11-05 | T-0552 | #217 | Sonnet APPROVE (1 fix round: no backdating) | green |
| 2026-11-05 | T-0554 | #220 | Sonnet APPROVE | green |
| 2026-11-05 | T-0555 | #221 | Sonnet APPROVE; desktop PASS (enum value usable) | green |
| 2026-11-05 | T-0550 | #222 | Sonnet APPROVE (non-blocking: allowance `payMember` unguarded, noted in the card); desktop PASS on real Postgres (reserve race) | green |
| 2026-11-05 | T-0661 | #224 | Sonnet APPROVE (static; tests run locally) | green |
| 2026-11-05 | T-0670..T-0678 | #225 | Haiku REQUEST_CHANGES then fixed (file lists, titles); docs only | green |
| 2026-11-05 | T-0670 | #228 | Sonnet APPROVE (nits fixed) | green |
| 2026-11-05 | T-0671 | #229 | Sonnet REQUEST_CHANGES then APPROVE (direction on web only, card scope stated) | green |
| 2026-11-05 | T-0672 | #231 | Sonnet APPROVE | green |
| 2026-11-05 | T-0673 | #232 | Sonnet APPROVE | green |
| 2026-11-05 | T-0674 | #234 | Sonnet REQUEST_CHANGES (opacity dimmed the text, ~3:1) then APPROVE after a colour change | green |
| 2026-11-05 | T-0675 | #235 | Sonnet APPROVE (nits fixed: colour-scheme, radio/file inputs) | green |
| 2026-11-05 | T-0676 | #236 | Sonnet APPROVE | green |
| 2026-11-05 | T-0677 | #237 | Sonnet APPROVE (type-scale note added) | green |
| 2026-11-05 | T-0678 | #239 | Haiku REQUEST_CHANGES twice (plan-name note, stale base) then APPROVE | green |
| 2026-11-05 | T-0056 | #241 | Sonnet APPROVE (2 fix rounds: key pair as one unit, PII keys never rotated) | green |
| 2026-11-05 | T-0040 | #230 | Sonnet APPROVE (2 fix rounds: the unknown-key refusal would have broken boot) | green |
| 2026-11-05 | T-0044 | #233 | Sonnet APPROVE (2 fix rounds: per-step env, terraform test mock) | green |
| 2026-11-05 | T-0057 | #242 | Sonnet APPROVE (1 fix round: relaxed DMARC alignment, long DKIM keys) | green |
| 2026-11-06 | T-0063 | #245 | Sonnet APPROVE (first round) | green |
| 2026-11-06 | T-0061 | #247 | Sonnet APPROVE (first round; lint error in the new test fixed before review) | green |
| 2026-11-06 | T-0679 | #253 | Sonnet APPROVE (trailing blank line fixed); desktop recordings not run, test ids kept | green |
| 2026-11-06 | T-0413 | #250 | independent APPROVE (1 fix round: converted-authorisation test, stale comment) | green |
| 2026-11-06 | T-0064 | #252 | independent changes-requested then fixed (wrong column and table in the pg proof, unneeded sequence grant, replay assertion); desktop PASS; two items carried to T-0045 | green |
| 2026-11-06 | T-0045 | #255 | independent review: 1 defect (prod terraform assert missing) fixed; jit status probe without DB | green |
| 2026-11-06 | T-0053 | #257 | independent changes-requested then fixed (invalid EMF unit, US-banking breaks missed, dead provider.error emit, mixed-currency sum) | green |
| 2026-11-06 | T-0054 | #258 | independent changes-requested then fixed (nonexistent last(), thresholds that would page constantly, daily-job windows, connection alarm); terraform never run locally, CI was the first check | green |
| 2026-11-07 | T-0055 | #259 | independent changes-requested then fixed (error gate blind to TIMEOUT declines, card count vs velocity rule, prod guard backslash bypass); k6 never run, first result pending a human run | green |
| 2026-11-07 | T-0680 | #260 | Sonnet APPROVE (stale decision columns now cleared) | green |
| 2026-11-07 | T-0051 | #263 | independent changes-requested then fixed (vacuous webhook check, admin check passing on any network error, impossible strict gate command, URL-guard bypass); never run against a deployed environment | green |
| 2026-11-08 | T-0047 | #264 | independent APPROVE (no blockers; 2 known limits recorded as T-0068/T-0069); desktop docker run PASS after one fix (tokens build) | green |
| 2026-11-08 | T-0049 | #265 | independent changes-requested then fixed (scan gate could never fail: missing pipefail; nonexistent Terraform resource; gate passing without an enhanced scan); admin image tokens fix | green |
| 2026-11-08 | T-0050 | #266 | independent changes-requested then fixed (staging pager, account-id agreement, stale soak, orphaned migrate task, vacuous tests); prod IAM scope gap recorded as T-0070; never run against AWS | green |
| 2026-11-08 | T-0046 | #268 | independent changes-requested then fixed (pnpm `--` form, unmasked argument echo, opaque driver errors, weak refusal test); creates the 8 system accounts only: first admin (T-0072) and legal shells (no draft state) blocked; found the audit lock defect (T-0071); not run against AWS | green |
| 2026-11-08 | T-0071 | #269 | independent APPROVE (no blockers); weaker-test points fixed (lock proven in pg_locks, READ COMMITTED guard); two real sessions queueing on the lock not exercised | green |
| 2026-11-08 | T-0042 | #271 | independent review, no merge blockers; fixed the JIT service receiving every vendor secret, the dead both-or-neither message, `__proto__` product codes, a header-only Apple key check; bootstrap race test timeouts raised; no vendor sandbox run | green |
| 2026-11-08 | T-0067 | #272 | independent APPROVE (no blockers; scope and typing nits fixed); desktop real-Postgres PASS | green |
| 2026-11-08 | T-0065 | #273 | independent not-mergeable then fixed (corrected re-proposals silently dropped, a text could never be proposed twice, version-numbering race, late approval, input checks); ledger 0029 desktop PASS and atlas hash clean | green |
| 2026-11-08 | T-0062 | #274 | independent review then fixed (consent bypass by deep link, consent screen dead end with no web base URL, toggle double-fire, fail-open on endpoint mismatch); never rendered on a device; per-product consent and the T-0066 gate are owner questions | green |
| 2026-11-09 | T-0048 | #276 | independent review then fixed (CloudFront could not decrypt the SSE-KMS web bucket so every page would 403, root `pnpm build` broken by Turbo strict env, effective date in UTC, Stripe file trailing newline, partial-upload on find failure); legal pages are frozen at build time (redeploy on publish and on effective date); workflow never run against AWS; staging/prod builds fail until real bundle ids, team id, cert fingerprint and support email are set (T-0058) | green |
| 2026-11-09 | T-0657 | #279 | Sonnet APPROVE (as-built notes added); checked against the real Crowded sandbox | green |
| 2026-11-09 | T-0681 | #282 | Sonnet REQUEST_CHANGES (sweep missed the read inside release) then fixed per their option, not re-reviewed; CI green | green |
| 2026-11-09 | T-0073 | #281 | independent review, no blockers; fixed the unproven "app bug" claim (now observed-in-script only), Ctrl-C cleanup and leftover key file, a test title; 23 of 24 screenshots re-taken, T-0612-bad-iban kept (state unreachable since T-0625, owner to decide); recorder signal cleanup not run at runtime | green |
| 2026-11-10 | T-0043 | #287 | Sonnet APPROVE (first round) | green |
| 2026-11-10 | T-0041 | #288 | Sonnet REQUEST_CHANGES (branch stale against main after T-0043; no test of the prod guard with Stripe bound) then fixed and re-reviewed APPROVE | green |
| 2026-11-10 | T-0683 | #290 | Sonnet APPROVE (first round; the funding port had no listing, added as a separate interface) | green |
| 2026-11-10 | T-0684 | #291 | Sonnet REQUEST_CHANGES twice (unindexed ledger.journal.transfer_id join; payouts could show as false breaks; alarms test count) then fixed and confirmed APPROVE, desktop PASS | green |
| 2026-11-10 | T-0682 | #289 | Sonnet APPROVE (every requireStepUp and isFresh call site awaited), desktop PASS, main merged in and the delta confirmed | green |
| 2026-11-10 | T-0685 | #293 | Sonnet APPROVE (ApprovalService.decide change only touches ledger_correction), main merged in and the delta confirmed | green |
| 2026-11-10 | T-0690 | #294 | Sonnet APPROVE (security review of the workflow: no PR trigger, per-job secrets, no injection) | green |
| 2026-11-10 | T-0689 | #295 | Sonnet APPROVE then fixed (forged deliveries with no event id were not counted) and re-reviewed APPROVE | green |
| 2026-11-10 | T-0687 | #296 | Sonnet REQUEST_CHANGES (a sink SQL error would abort the whole batch: per-message savepoint) then fixed and APPROVE, desktop PASS | green |
| 2026-11-10 | T-0691 | #298 | Sonnet APPROVE (security review of the sign-in path) | green |
| 2026-11-10 | T-0068 | #297 | Sonnet REQUEST_CHANGES (a tftest indexed an empty action list, which CI confirmed; the companion rule nested too deep) then rebuilt as three flat rules and APPROVE, terraform job green | green |
| 2026-11-10 | T-0688 | #300 | Sonnet REQUEST_CHANGES (DELETE left the endpoint live at the provider, so it could keep receiving events or resume) then fixed with EventsPort.deleteEndpoint and APPROVE | green |
| 2026-11-10 | T-0694 | #301 | Sonnet REQUEST_CHANGES (unlink would fail in production: club_app has no DELETE on ops.external_ref) then unlink dropped and APPROVE, desktop PASS | green |
| 2026-11-10 | T-0692 | #302 | Sonnet APPROVE (revoke runs only after the account is closed; a retry mends a half-finished closure) | green |
| 2026-11-10 | T-0695 | #307 | Sonnet APPROVE (retry is ACH-only, same wire key, injected sleep, no retry on network/5xx/book; two nits carried) | green |
| 2026-11-10 | T-0069 | #306 | Sonnet REQUEST_CHANGES twice (the internal ALB admitted the whole VPC so a Client VPN user could forge the client address; then a for_each over an unknown security-group id would fail at plan) then restricted to the console security group with count and APPROVE, terraform job green | green |
| 2026-11-10 | T-0695 nits | #309 | Sonnet APPROVE (the reviewer's own suggested fix would have broken the retry on the live 409, which has no `code` field: matched on the message prefix instead) | green |
| 2026-11-10 | T-0556 | #313 | Sonnet APPROVE (cancel-first order has no double-spend path); CI's oasdiff flagged the new `cancelled` state, accepted in oasdiff-ignore.txt and the delta re-reviewed APPROVE | green |
| 2026-11-10 | T-0557 | #314 | Sonnet REQUEST_CHANGES (the catch refunded the credit of an order whose insert had committed but whose reply was lost: free data on retry) then fixed with a get-first check and APPROVE | green |
| 2026-11-10 | T-0558 | #317 | Sonnet APPROVE then three follow-ups fixed (no marker on a failed read so a transient `fail()` error is retried; monotonic upsert; the worker handles an unknown held load) and re-reviewed APPROVE; migration 0032 recomputed atlas.sum independently, desktop PASS on real Postgres (upsert, FK, no delete grant) | green |
| 2026-11-11 | T-0696 | #321 | Sonnet APPROVE (no duplicate or foreign-parent adoption path; found the live parent field first: `masterChapterId` on GET /chapters/{id}, none on the list, so the fake was corrected before review) | green |
| 2026-11-11 | T-0734 | #325 | Sonnet REQUEST_CHANGES (a doc claim that no derived UUID is stored was false: `bookTransfer`'s ref holds it) then fixed and APPROVE; found by the live sandbox: Crowded rejects any idempotency key that is not a UUID v4 and our keys were v5, so every live ACH send would have failed | green |
| 2026-11-11 | T-0697 | #328 | Sonnet REQUEST_CHANGES (the hosted-load payer IP accepted any string and the redirect URLs were unconstrained) then fixed with a public-IP check and https-only URLs, reviewer ran its own adversarial IP and URL cases, APPROVE | green |
| 2026-11-11 | T-0718 | #326 | Sonnet REQUEST_CHANGES three rounds (the port could not detect a reused key with a different body; read-back by key is not something the vendor has; the contract asserted vendor behaviour the sandbox does not show), reshaped from live probes (read-back by memo, echoed stored leg, payments listing), a container restart lost the builder mid-fix and a replacement finished it, APPROVE | green |
| 2026-11-12 | T-0699 | #331 | Sonnet APPROVE (merged 91f688d); non-blocking nits carried: a per-item Failed create with no id or mobile maps to PROVIDER_UNAVAILABLE, not VALIDATION_FAILED; the sandbox test mobile space is only 10k values; unknown contact statuses fail secure; the DOB bound 1900..today is our own sanity bound; open question: how a rejected member re-applies; owner action: add the Actions secret CROWDED_SANDBOX_CHAPTER_ID | green |
| 2026-11-12 | T-0700 | #332 | Sonnet APPROVE (merged d471fd0), non-blocking; payment-event follow-ups carried to T-0703 | green |

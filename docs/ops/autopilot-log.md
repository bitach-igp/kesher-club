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

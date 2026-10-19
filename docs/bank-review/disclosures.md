# Disclosures and consent

Every legal document the app can show a member, where it is shown, how consent is recorded, and when
consent is asked again, as coded at commit `fb4c6de`. Pre-payment disclosures (insurance, FX, P2P
conversions, holds) follow in a second table.

**In short:** the versioning and consent engine exists and is tested, but no document version is
published, no screen shows one yet, and the API exposes no legal endpoint. The index below is
therefore of the document types the system supports, not of live text. Each gap is an `Open:` line.

## The legal document engine

- Documents are versioned per document type. Each version holds an English and a Hebrew title and body;
  publishing refuses a version without both bodies (`apps/api/src/legal/service.ts:64-77`;
  `db/migrations/legal/0001_init.sql:4-19`).
- Each version carries a SHA-256 hash of its type and both bodies, stored again on every consent
  (`apps/api/src/legal/service.ts:66`; `db/migrations/legal/0001_init.sql:11`).
- Each version has an effective date; the version in force is the latest one whose effective date has
  passed (`apps/api/src/legal/service.ts:84-89`).
- Each version is marked material or not, with an optional change summary in both languages
  (`db/migrations/legal/0001_init.sql:12-14`).
- Versions are read-only to the application: publishing is a back-office action
  (`db/migrations/legal/0001_init.sql:39`).

Proved by `apps/api/src/legal/legal.test.ts:20`.

## Index of document types

| Document key | What it is | Where it is shown today | Where the code expects it |
|---|---|---|---|
| `terms` | Club terms of membership | nowhere yet | sign-up and re-accept sheet |
| `privacy` | Privacy notice | nowhere yet | sign-up and re-accept sheet |
| `cardholder` | Cardholder agreement | nowhere yet | before card issue |
| `esim` | eSIM terms | nowhere yet | eSIM checkout |
| `insurance` | Insurance terms | nowhere yet | insurance checkout |
| `p2p` | Member transfer terms | nowhere yet | before the first send |
| `funder` | Terms for a parent or funder | nowhere yet | funder sign-up |

Sources: the seven keys are the only ones the table accepts (`db/migrations/legal/0001_init.sql:5`;
`apps/api/src/legal/service.ts:8`). No migration or seed inserts a version
(`db/migrations/legal/0001_init.sql:1-40` creates tables only).

Open: the "Where the code expects it" column is the plain meaning of each key; the code does not say
which screen shows which document. Product and legal decide the placement.

Open: no version of any document is published. Legal supplies the first versions of all seven, in
English and Hebrew.

Open: the API builds no legal service and has no legal route (`apps/api/src/app.ts:86-157` creates no
`LegalService`; `apps/api/src/routes.ts:15-89` has no `/legal` path). The mobile app has no consent or
terms screen: its screen copy (`apps/mobile/src/i18n.ts`) has no terms, privacy, consent or disclosure
text, and its routes are sign-in, home, card, club, convert, help, pay, settings and wallet
(`apps/mobile/app/`). The web portal that is
meant to host the legal pages is not started (`apps/web/README.md:3-5`). The engineering lead schedules
the cards; legal and compliance decide whether any money flag may turn on before members accept terms.

## How consent is recorded

- One record per member, document and version, holding the version's hash, the device, the IP address,
  the language and the time (`apps/api/src/legal/service.ts:92-105`;
  `db/migrations/legal/0001_init.sql:23-35`).
- Accepting the same version again changes nothing and returns the first record
  (`apps/api/src/legal/service.ts:91`, `:100-104`).
- Consent records can be added but never changed or deleted by the application
  (`db/migrations/legal/0001_init.sql:22`, `:40`).
- Staff see a member's consents, newest first, on the Customer 360 page of the admin console
  (`apps/api/src/admin/customers.ts:178`; `apps/admin/app/customers/[id]/page.tsx:104`).

Proved by `apps/api/src/legal/legal.test.ts:30` (recorded once, with the evidence) and `:66` (a member's
consents in audit order).

Open: the Customer 360 page links each consent to `/legal/{document}/{version}.pdf`
(`apps/admin/app/customers/[id]/page.tsx:104`), but the console has no such route (`apps/admin/app/`
holds only `auth`, `compliance`, `customers`, `providers` and the shell). The engineering lead adds the
route or removes the link.

## When consent is asked again

| Event | Is consent asked again? | Source |
|---|---|---|
| The member has never accepted a document that has a material version in force | yes, reason `first` | `apps/api/src/legal/service.ts:107-129` |
| A new material version takes effect after the member's last consent | yes, reason `material_change` | `apps/api/src/legal/service.ts:107-129` |
| A new version that is not material takes effect | no | `apps/api/src/legal/service.ts:115-116`, `:124` |
| A version is published with a future effective date | not until that date | `apps/api/src/legal/service.ts:114`; test `apps/api/src/legal/legal.test.ts:58` |
| The member joins a new market (US or IL) | no rule in code | see Open |
| The member's role changes (for example becomes a funder) | no rule in code | see Open |

Proved by `apps/api/src/legal/legal.test.ts:39` (re-accept only after a material version) and `:58`
(future versions are not yet pending).

Open: a document version has no market column (`db/migrations/legal/0001_init.sql:4-19`), although the
API runs per market (`apps/api/src/app.ts:70`). There is no way to hold different US and Israeli
versions, or to ask again when a member's market changes. Legal decides whether per-market versions are
needed.

Open: if a document's only version in force is not material, `pending()` never asks for it, even from a
member who has never accepted it, because the rule needs a material version in force
(`apps/api/src/legal/service.ts:116`, `:122`). Legal confirms that every first version will be published
as material.

## Pre-payment disclosures

These are shown before money moves. They are part of the transaction, not versioned documents.

| Disclosure | Shown before | What the member sees | Source | Test |
|---|---|---|---|---|
| Insurance: licensed entity, policy wording link, commission | buying cover | the three items, returned with every quote | `packages/ports/src/insurance.ts:1-10` | TST-INSR-001, `packages/ports/src/insurance.contract.ts:14-18` |
| Insurance: acknowledgement | paying for cover | an order without the acknowledgement is refused | `apps/api/src/addons/orders.ts:98` | `apps/api/src/addons/orders.test.ts:125` |
| Catalogue disclosures | any add-on that carries them | the item's disclosures, listed with its price | `apps/api/src/app.ts:179-183` | none found |
| FX quote | converting between purses | rate, markup, markup in basis points, total, rate version, expiry (30 s) | `apps/api/src/fx/service.ts:31-43`, `:22` | TST-FX-001, `apps/api/src/fx/service.test.ts:63`; `apps/mobile/app/convert/fx.model.test.ts:67` |
| P2P conversion preview | a send the recipient receives in the other currency | sent amount, received amount, rate, rate version | `apps/api/src/p2p/send.ts:133-148` | `apps/api/src/p2p/send.test.ts:268`; `apps/mobile/app/pay/pay.model.test.ts:271` |
| Load conversion | a load into the other purse | the amount credited and the rate version | `apps/api/src/wallet/loads.ts:307-317` | TST-WAL-006, `apps/api/src/wallet/loads.test.ts:335` |
| ACH hold | an ACH load | "on hold until" the release date | `apps/api/src/wallet/loads.ts:313`; `packages/ports/src/funding.ts:15-16` | `apps/api/src/wallet/loads.test.ts:175` |
| New-counterparty hold | a first large send | the release time and a cancel option | `apps/api/src/p2p/send.ts:355-363`; `apps/api/src/p2p/holds.ts:1-5` | `apps/mobile/app/pay/pay.model.test.ts:225` |
| Payout cooling-off | a large first payout | the scheduled date | `apps/api/src/payouts/service.ts:322` | `apps/api/src/payouts/service.test.ts:90` |

Open: the insurance acknowledgement is checked but not stored; the order row has no field for it
(`apps/api/src/addons/orders.ts:106`). Compliance decides whether the acknowledgement must be kept as
evidence, like a consent record.

Open: the insurance and eSIM flags are off (`config/flags.json:45-49`, `:59-63`); the insurance flag
waits on "Distribution agreement + disclosures approved" (`config/flags.json:63`). Legal approves the
disclosure text.

## Staff visibility consent (institutions)

A member of an institution decides whether its staff may see their merchant-level spending. Without
that grant, staff see only a balance band and fees owed.

- The grant is a row per member, institution and scope, with grant and revoke times
  (`db/migrations/org/0001_init.sql:80-88`).
- Postgres row-level security enforces it, not application code; revoking hides the data at once
  (`db/migrations/org/0001_init.sql:118-128`).

Proved by TST-INS-005 (`apps/api/src/institutions/consent.test.ts:37`, `:46`, `:54`, `:60`, `:72`).

Open: no endpoint or screen lets a member give or revoke this grant (no caller of `org.consent_grant`
outside tests). Product decides where the member manages it; legal supplies the wording.

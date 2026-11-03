# Crowded public API: integration inventory

Source: Postman public collection "Crowded API Docs" (collection id `a054ce79-ab11-487e-a7dc-b17246f47b1a`, published id `2sBYArTsS6`, published 2026-08-20), read from its JSON export on 2026-11-03: https://documenter.getpostman.com/view/20019814/2sBYArTsS6 . Public documentation, data only; re-check against the live docs before building.

Coverage: 85 requests in 15 top-level folders, which collapse to 79 distinct method + path operations. Five payment-origination requests share `POST /api/v1/chapters/{chapterId}/payments` (type `book`, `ach`, `achCounterparty`, `wire`, `wireCounterparty`). Three doc pages share `GET /api/v1/webhooks/event-types`. Every request's description, parameters, body and example responses were read. Anything the docs do not state is marked UNCONFIRMED.

---

## 1. Overview

- **Sandbox base URL:** `https://sandbox-api.crowdedfinance.com` (collection variable `base_url`). All paths are under `/api/v1`.
- **Production base URL:** UNCONFIRMED. The docs say a Production environment exists ("live environment with real financial transactions") but give no host.
- **API version:** the URL prefix `/api/v1`. The webhook envelope carries `version: "1.0"`. No version header is documented.
- **Environments:** Sandbox ("development and testing with simulated data") and Production. Sandbox-only routes under `/sandbox/*` return 404 in production.
- **Entity hierarchy:** Organization → Chapter (= operational unit; holds Contacts, Accounts, Cards, Collections, Counterparties, Applications). Collection → Intent (one contact's assignment in a collection) → Payments. Subaccounts are chapters that share a parent chapter's EIN.
- **Support contact (from docs):** support@bankingcrowded.com
- **Money movement scope:** USD only. Counterparty addresses, card shipping and bank applications are US-only; see section 7.

## 2. Authentication

- **Scheme:** HTTP Bearer token. The docs say "All endpoints require authentication via Bearer token" with header `Authorization: Bearer <token>`.
- **Two token variables appear in the collection, with no explanation:**
  - Collection-level auth: `{{api_token}}` (placeholder value `abc`). Used by most requests.
  - Per-request header `Authorization: Bearer {{partner_jwt}}`, used by the requests below. `partner_jwt` is not defined as a collection variable.
- **Requests that send `partner_jwt` explicitly:** Create Onboarding Link (organization and chapter variants), Get / Create Application Form, List / Get Authorization, all Cards requests (list, get, create, freeze, unfreeze, close, report stolen, report lost, replace), List Payments and Get Payment (under collection intents), Cancel Payment Plan, List Chapter / Account Transactions, Generate Embedded Token, and the four `/sandbox/card-*` simulators.
- **How tokens are obtained, their lifetime, refresh and scopes:** UNCONFIRMED. The docs do not describe a token endpoint, client credentials, TTL or refresh. Rate limits are described as "based on your API key", but no API key credential is described either.
- **Partner scoping:** the partner only sees its own organizations and chapters. Errors: 403 when the partner lacks access to the chapter; 404 when the resource belongs to another card or chapter (existence is deliberately not confirmed across scopes).
- **Impersonation:** `X-Impersonate-User-Uid: <contact UUID>` header on Get Application Form Status (defaults to the chapter account owner). `contactId` body field on Create Application Form and Submit Bank Application (takes priority over the header). The acting contact must be the chapter account owner.
- **Embedded UI tokens:** `POST .../contacts/{contactId}/embedded-token` returns a short-lived JWT for embedding Crowded UI. Docs say to generate it server-side only. TTL is returned as `expiresIn` (seconds) with no fixed value documented.
- **Webhook authentication:** outbound deliveries can carry a custom `Authorization` header configured on the registration (for example `Bearer ...`), stored encrypted and never returned.
- **Public endpoint:** `GET /api/v1/webhooks/event-types` is documented as requiring no authentication.

## 3. Conventions

### 3.1 Envelope
- Single-item responses and request bodies are wrapped in `data`. Paginated lists return `data: []` plus `meta.pagination`.
- Exceptions:
  - Bulk bodies differ: `data` is a top-level array (Bulk Create Contacts, Bulk fund subaccounts); `data.items` (Bulk create accounts, Create Cards); `data.payments` (all payment-origination requests).
  - Some list responses return a named array plus `meta.limit / meta.offset / meta.count` instead of `meta.pagination`: origination Get all Payments, Get all Counterparties (`counterparties` array).
  - Delete and archive-webhook return 204 with no body. Counterparty DELETE returns 204.

### 3.2 Pagination
- Query params: `pagination[limit]` (1–100, default 10), `pagination[offset]` (default 0), `pagination[page]` (default 1). If both offset and page are sent, offset wins.
- `meta.pagination` = `{ total, limit, offset, sort, order }`.
- Examples mix `pagination[page]` and `pagination[offset]`; which parameter each endpoint accepts is not stated per endpoint.

### 3.3 Sorting and filters
- `sort[field]` and `sort[direction]` (ASC or DESC, default DESC). Allowed sort fields vary by endpoint (for example `name`, `createdAt`, `amount`, `status`, `method`, `firstName`, `lastName`, `url`, `isActive`).
- Filters use `filter[...]`. Array filters are written two ways: `filter[status][]=...` (Cards, collection payments) and repeated `filter[status]=...` or comma-separated (Authorizations MCC: `filter[merchantCategoryCode]` accepts repeats or a comma list). Treat the exact syntax per endpoint as UNCONFIRMED.
- `include[]=collectBalance` is repeatable; comma-separated values are not supported. Accounts list uses `include=limits`.

### 3.4 Idempotency
- There is no `Idempotency-Key` header. Idempotency is body-level, with a field named `idempotencyKey` (UUID v4 in most docs):
  - Required: Submit Bank Application (UUID), Create Subaccounts, Bulk fund subaccounts (per item), Bulk create accounts, Create Cards (per item and request), Create Counterparty (UUID v4; "created at most once"), all origination payments (per payment; "effective for approximately 48 hours" for ACH and wire), Collect Platform Charges.
  - Optional: Release Funds and Move Fees (auto-generated when absent).
  - Upsert semantics instead of a key: Create Payment Intent (returns the existing intent per contact and collection; Dues intents once paid are returned unchanged), Create Application Form (returns the existing in-progress form for the acting contact).
  - No idempotency documented: Create Organization, Create Chapter, Bulk Create Contacts, Create Collection, Quote endpoints (documented as side-effect free). Retrying these may create duplicates. UNCONFIRMED how duplicates are detected.
- Key length or format limits beyond UUID: not documented. Behavior when a key is reused with a different body: not documented.

### 3.5 Rate limits and throttling
- 1,000 requests per minute per API key (from docs). Bulk operations are limited to 100 items per request in general, but specific endpoints document lower caps: 10 items for Bulk create accounts, Create Cards, Book payments; exactly 1 payment per request for ACH and wire origination.
- 429 is documented only for subaccount creation over the subscription tier limit ("Subscription quota exceeded"). Response headers for rate limiting are not documented. A generic 429 for the 1,000/min limit is UNCONFIRMED.

### 3.6 Errors
- Error bodies in examples: `{ "type": "<ErrorType>", "statusCode": <n>, "message": "...", "requestId": "..." }`. `type` values in examples: `ResourceInputError` (400), `ForbiddenError` (403), `ResourceConflictError` (409). The docs also name `ValidationError` (400) in an error table but show no example. A 404 example shows only `statusCode` and `message`.
- Common statuses documented globally: 400 (validation), 401 (missing, invalid or expired token), 403 (no permission or wrong role), 404 (not found).
- Domain error codes appear inside endpoint docs, for example: `CANNOT_CANCEL`, `DUPLICATE_REQUEST` (409), `COUNTERPARTIES_NOT_ENABLED` (403), `CANNOT_UPDATE_LINKED` and `CANNOT_DELETE_LINKED` (400), `CONTACT_NOT_FOUND`, `PROVISION_FAILED`, `APPLICATION_EXIST`, `EIN_DUPLICATE_BLOCKED`, `INSUFFICIENT_FUNDS`, `ACCOUNT_UNAVAILABLE`, `DUPLICATE_PAYMENT`, `PAYMENT_FAILED`, `COUNTERPARTY_ADDRESS_REQUIRED`, `NOT_FOUND`, `VALIDATION_ERROR`. No complete code catalogue is given.
- Business rejections are not HTTP errors: Release Funds, Move Fees and Collect Platform Charges return 201 with `status: "Rejected"`, plus `reason` and `reasonCode`.
- Bulk endpoints return 200 with per-item `error` flags and counts (`successCount`, `failedCount`). Partial success is normal.

### 3.7 Money
- Integer minor units (cents). Example: $100.00 = `10000`. Fields are typed `number`.
- Exceptions to watch:
  - Collect Payments `standardAmount` is documented as "Total amount in standard currency units". The example pairs `amount: 10300` with `standardAmount: 103`. Whether this is whole dollars or a decimal is UNCONFIRMED.
  - Counterparty and payment minimums: ACH minimum `100` ($1.00); wire minimum `10000` ($100.00); collection `requestedAmount` minimum `100`.
  - Subaccount bulk-fund `amount` has no unit or minimum documented (example `2000`).
- Currency: USD only (`currency: "USD"` in responses).
- Amount semantics differ by surface: REST collect payments `amount` "includes fee"; webhook collect payment `amount` is "Net payment amount ... (what org receives)". See section 7.

### 3.8 Dates
- ISO 8601 timestamps, usually UTC. Examples mix `2025-01-01T00:00:00Z` and `2025-01-01T00:00:00.000Z`.
- Dates of birth and payment-plan dates: `YYYY-MM-DD`. Card expiration: `YYYY-MM`. Year of incorporation: `YYYY`.

### 3.9 Phone and identifiers
- Mobile numbers: E.164 (for example `+15551234567`). Application phone is split as `countryCode` plus `number` (digits only).
- EIN: 9 digits, no dashes. SSN: 9 digits, no dashes. ZIP: `12345` or `12345-6789`. State: 2-letter USPS code (50 states plus territories). Routing number: ABA, 9 digits. Account number: 3–17 digits.
- ID formats are mixed: UUIDs for organizations, chapters, contacts, collections, intents, webhook registrations and collection payments; numeric strings for cards (`cardId`), authorizations, counterparties, origination payments (examples `1287345`), and transactions (`id` typed `number`). A format guarantee for any ID is UNCONFIRMED.
- Collection payment `uid` is a deprecated alias of `id`.

### 3.10 Status and enum casing (inconsistent across surfaces)
- Collection intents: `Paid`, `Pending`, `Returned`, `Cancelled`, `Not Paid`.
- Collection payments (REST): `Pending`, `Processing`, `Succeeded`, `Failed`, `Returned`, `Refunded`, `Cancelled`. Methods: `Card`, `Ach`, `Cash`, `Check`, `Wire`, `Other`.
- Collection payments (webhooks): `pending`, `processing`, `succeeded`, `failed`, `canceled`, `returned`, `refunded`. Methods: `card`, `ach`, `cash`, `check`, `external`.
- Origination payments: `pending`, `processing`, `sent`, `returned`, `canceled`, `failed` (lowercase). Methods: `book`, `ach`, `wire`. Fee status: `charged`, `failed`, `partner_billed`, `none`.
- Release, Move Fees and Platform Charges: `Pending`, `Sent`, `Rejected`.
- Other enums: Chapter `Active | Archived`; Account `Open | Closed | Frozen`; Card `Active | Inactive | Frozen | ClosedByCustomer | Stolen | Lost | SuspectedFraud`; Authorization `Authorized | Completed | Canceled | Declined`; Contact `Active | Failed | Archived`; Application `Pending | PendingReview | AwaitingDocuments | Approved | Denied | Canceled | FormInProgress`; Webhook event delivery `pending | processing | delivered | failed | dlq`.

---

## 4. Endpoint inventory

Paths are shown without the `https://sandbox-api.crowdedfinance.com` prefix. `{x}` means a path parameter. "Req" means required body or query fields. Response field lists come from the documented response tables and example responses.

### 4.1 Organizations (4)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/organizations | Create a parent organization attributed to the partner | `data.name` (req, max 255) | `id`, `name`, `createdAt` |
| GET | /api/v1/organizations | List organizations the partner can see | `search`, `sort[field]` (name, createdAt) | `data[]`: `id`, `name`, `createdAt`; `meta.pagination` |
| GET | /api/v1/organizations/{organizationId} | Get one organization | none | `id`, `name`, `createdAt` |
| POST | /api/v1/organizations/onboarding-links | Mint a single-use link that lets an invitee self-onboard a new organization under the partner (uses `partner_jwt`) | `data.theme` (UUID, optional) | `linkId`, `url`, `shortUrl`, `expiration` (ISO). Reconcile via `partnerInvitationId` on `platform.organization.created` |

### 4.2 Chapters (5)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters | Create a chapter in an organization; optionally create its admin (owner) contact | `data.name` (req, max 255), `data.organizationId` (req), `data.businessVertical` (req, enum of 17 values), `data.owner` (optional: `firstName`, `lastName`, `mobile` E.164, `email` (all req), `dateOfBirth` optional) | `id`, `name`, `organization`, `organizationId`, `status` (Active), `businessVertical`, `ein` (null), `createdAt`, `contactId` (only when `owner` sent) |
| GET | /api/v1/chapters | List chapters across the partner's organizations | `search`, `sort[field]` (name, createdAt), `sort[direction]`, `filter[organizationId]`, `filter[isMasterSubAccount]`, `filter[isMasterSubEntity]`, `include[]=collectBalance`, pagination (page form in example) | `data[]`: `id`, `name`, `organization`, `organizationId`, `status` (Active or Archived), `businessVertical`, `ein`, `masterChapterId`, `isMasterSubAccount`, `isMasterSubEntity`, `createdAt`, `collectBalance` (opt-in), `collectCaptured`, `collectInTransit` (cents) |
| GET | /api/v1/chapters/{chapterId} | Get one chapter | none | Same as list. `collectBalance` present only when banking is enabled. `collectCaptured` and `collectInTransit` always returned (default 0) |
| POST | /api/v1/chapters/{id}/archive | Archive a chapter | `reason` (example `ByCustomer`) | Chapter object with `status: "Archived"`; documented as 202 |
| POST | /api/v1/chapters/{chapterId}/onboarding-links | Mint a single-use link to onboard a new child chapter in the same organization (for a child that needs its own KYB) | `data.theme` (opt), `data.email` (opt; email mode), `data.firstName` and `data.lastName` (only with email; otherwise 400) | `linkId`, `expiration`; `url` and `shortUrl` only in link mode. Email mode emails the invite. Reconcile via `partnerInvitationId` on `platform.chapter.created` |

Business verticals (enum): `SororitiesFraternities`, `Camp`, `Scouts`, `GradeSchoolGroup`, `SocialClub`, `SportsClub`, `CollegeGroup`, `ReligiousCivicAndSocialOrganizations`, `EducationalServices`, `ArtsEntertainmentAndRecreation`, `HealthCareAndSocialAssistance`, `AgricultureForestryFishingOrHunting`, `FinancialServicesOther`, `PersonalCareServices`, `PublicAdministration`, `RealEstate`, `TechnologyMediaOrTelecom`.

### 4.3 Application (4): banking application and hosted form

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/applications | Submit a bank application directly. Records consent via `contactIp`. Returns 409 while a hosted form is in progress | `data.organizationName` (req), `ein` (req, 9 digits), `stateOfIncorporation` (req, 2-letter), `yearOfIncorporation` (req, YYYY, not in the future), `website` (req), `address` (req: `street`, `street2`, `city`, `state`, `postalCode`, `country`), `phone` (req: `countryCode`, `number`), `officer` (req: `fullName.first`, `fullName.last`, `address`, `ssn` (9 digits), `title` (enum, optional)), `idempotencyKey` (req, UUID), `contactIp` (req), `contactId` (opt) | `createdAt`, `status` (Pending, PendingReview, AwaitingDocuments, Approved, Denied, Canceled), `additionalConsentUrl` |
| GET | /api/v1/chapters/{chapterId}/applications | Get the application, or the form state when none is submitted | none | `createdAt` (absent when FormInProgress), `status` (adds FormInProgress), `additionalConsentUrl`, `formStatus` (EnterBusinessInformation or InProgressByAnotherUser, only when FormInProgress), `formUrl` (present while pending, pending review, awaiting documents, or in progress). 400 "There is no application for this chapter" when neither exists |
| GET | /api/v1/chapters/{chapterId}/applications/form | Check the hosted form status and whether it can be resumed (no side effects; uses `partner_jwt`) | Header `X-Impersonate-User-Uid` (opt) | `status` (EnterBusinessInformation, PendingCreation, InProgressByAnotherUser, ApplicationExists), `url` (string or null) |
| POST | /api/v1/chapters/{chapterId}/applications/form | Create or resume the hosted application form (records consent; uses `partner_jwt`). Idempotent per acting contact | `data.contactIp` (req; end user's IP, not the partner server's), `data.contactId` (opt; must be account owner) | 201: `status`, `url`. 400 validation; 403 when the acting contact is not the account owner or the chapter is not owned by the partner |

Officer title enum: `CEO`, `COO`, `CFO`, `President`, `BenefitsAdministrationOfficer`, `CIO`, `VP`, `AVP`, `Treasurer`, `Secretary`, `Controller`, `Manager`, `Partner`, `Member`.

### 4.4 Subaccounts (2)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/subaccounts | Create a subaccount that shares the parent EIN, with its own deposit account and a treasurer | `name` (req, max 255), `idempotencyKey` (req), exactly one of: `owner` (`firstName`, `lastName`, `mobile`, `email` req; `dateOfBirth` opt) or `email` (+ opt `firstName`, `lastName`) | `id`, `name`, `parentChapterId`, `status` (Active or Archived), `createdAt`, `owner` (`id`, `firstName`, `lastName`, `email`, `mobile`, `status` (Active, Invited or Failed), `error`). Owner failure does not fail the subaccount. Errors include 429 (tier limit) |
| POST | /api/v1/chapters/{chapterId}/subaccounts/fund | Bulk-fund subaccounts from the parent | `data[]`: `id` (subaccount), `amount` (units UNCONFIRMED; example 2000), `description`, `idempotencyKey` | UNCONFIRMED. No response is documented for this request |

### 4.5 Contacts (5)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/contacts | Bulk-create contacts (members). Each item is processed independently; duplicate mobile in the chapter fails that item | `data[]`: `firstName`, `lastName`, `mobile` (E.164), `email` (all req); `dateOfBirth` (opt); `role` (`Admin` or `Contact`, default `Contact`) | 201: `data[]` each with `id`, `chapterId`, `firstName`, `lastName`, `mobile`, `email`, `dateOfBirth`, `status` (Active or Failed), `error` (`message`, `detail`), `createdAt`, `updatedAt`, `archivedAt` |
| GET | /api/v1/chapters/{chapterId}/contacts | List contacts | `search` (name, email, mobile), `sort[field]` (createdAt, firstName, lastName), pagination | `data[]`: `id`, `chapterId`, `firstName`, `lastName`, `mobile`, `email`, `dateOfBirth`, `status`, `createdAt`, `updatedAt`, `archivedAt`; `meta.pagination` |
| GET | /api/v1/chapters/{chapterId}/contacts/{contactId} | Get one contact | none | Same fields as list item |
| PATCH | /api/v1/chapters/{chapterId}/contacts/{contactId} | Update name, email or date of birth (documented 202) | `data.firstName`, `data.lastName`, `data.email`, `data.dateOfBirth` | Contact object |
| POST | /api/v1/chapters/{chapterId}/contacts/{contactId}/archive | Archive (soft delete) a contact (documented 202) | `reason` | Contact object with `status: "Archived"` |

### 4.6 Accounts (3)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/accounts | Bulk-create deposit accounts (max 10) for contacts: `wallet` or `perdiem`. Optionally issues a digital card | `data.items[]`: `contactId` (req), `product` (`wallet` or `perdiem`), `withDigitalCard` (opt, default false); `data.idempotencyKey` (req) | `totalProcessed`, `successCount`, `failedCount`, `results[]`: `contactId`, `accountId`, `product`, `error` (bool), `errorCode`, `message`, `accountCreated`, `cardCreated`. Errors: `CONTACT_NOT_FOUND`, `PROVISION_FAILED` (per item) |
| GET | /api/v1/chapters/{chapterId}/accounts | List deposit accounts | `sort[field]` (createdAt), `include=limits` (opt) | `data[]`: `id`, `name` (holder), `status` (Open, Closed, Frozen), `accountNumber` (documented as "Bank account number"; shown unmasked in the example), `routingNumber`, `currency`, `balance`, `hold`, `available` (cents), `contactId`, `product` (checking, wallet, perdiem, hold, org), `createdAt`, `limits` (with `include=limits`) |
| GET | /api/v1/chapters/{chapterId}/accounts/{accountId} | Get one account | none | Same as list item; `limits` always included (best-effort). `limits.ach` and `limits.wire` each have `limits` (daily and monthly caps) and `totalsDaily` and `totalsMonthly` usage |

### 4.7 Cards (11): debit cards issued to contacts

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| GET | /api/v1/chapters/{chapterId}/cards/{cardId}/authorizations | List authorizations for a card | pagination (`limit`, `offset`), `sort[field]` (createdAt), `sort[direction]`, `filter[status]` (Authorized, Completed, Canceled, Declined), `filter[amount][min|max]`, `filter[createdAt][min|max]`, `filter[merchantCategoryCode]` (4-digit MCC; repeatable or comma list) | `data[]`: `id`, `accountId`, `cardId`, `amount`, `status`, `declineReason` (when Declined), `recurring`, `createdAt`, `merchant` (`name`, `mcc`, `location`); `meta.pagination` |
| GET | /api/v1/chapters/{chapterId}/cards/{cardId}/authorizations/{authorizationId} | Get one authorization | none | Same as list item. 404 if the authorization belongs to a different card |
| GET | /api/v1/chapters/{chapterId}/cards | List cards with balances, limits and totals | `filter[status][]` (Active, Inactive, Frozen), `filter[depositProduct][]` (wallet, perdiem, checking; default is checking and wallet only), `sort[field]` (createdAt), pagination | `data[]`: `cardId`, `contactId`, `contactName`, `last4Digits`, `accountId`, `depositProduct`, `expirationDate` (YYYY-MM), `balance`, `available`, `status`, `type` (physical or digital), `pinStatus` (Set, NotSet or null), `limits` (`dailyWithdrawal`, `dailyPurchase`), `dailyTotals` (`purchases`, `withdrawals`), `monthlyTotals` (`purchases`, `withdrawals`) |
| GET | /api/v1/chapters/{chapterId}/cards/{cardId} | Get one card | none | Same as list item |
| POST | /api/v1/chapters/{chapterId}/cards | Issue physical or digital cards (max 10 items). Physical issuance also provisions a digital card if none exists | `data.type` (physical or digital), `data.depositProduct` (wallet, perdiem, checking), `data.shippingType` (`standard`; physical only), `data.shippingAddress` (physical only; US only; `street`, `street2`, `city`, `state`, `postalCode`), `data.items[]` (`contactId`, `idempotencyKey`), `data.idempotencyKey` | `totalProcessed`, `successCount`, `failedCount`, `results[]`: `contactId`, `error`, `message`, `physicalCardCreated`, `digitalCardCreated`, `accountCreated`, `cardId`, `virtualCardId` (physical only), `accountId`, `balance`, `depositProduct`. Always 200; check per-item errors. Checking cards are Admin-only |
| POST | /api/v1/chapters/{chapterId}/cards/{cardId}/freeze | Temporarily suspend a card (reversible) | none | `cardId`, `contactId`, `contactName`, `last4Digits`, `accountId`, `depositProduct`, `expirationDate`, `status` (Frozen), `type` |
| POST | /api/v1/chapters/{chapterId}/cards/{cardId}/unfreeze | Restore a Frozen card to Active | none | Same shape; `status` Active |
| POST | /api/v1/chapters/{chapterId}/cards/{cardId}/close | Permanently close a card (irreversible) | none | Same shape; `status` ClosedByCustomer |
| POST | /api/v1/chapters/{chapterId}/cards/{cardId}/report-stolen | Permanently deactivate a stolen card (irreversible). Email to cardholder for physical cards | none | Same shape; `status` Stolen |
| POST | /api/v1/chapters/{chapterId}/cards/{cardId}/report-lost | Permanently deactivate a lost card (irreversible) | none | Same shape; `status` Lost |
| POST | /api/v1/chapters/{chapterId}/cards/{cardId}/replace | Ship a replacement physical card with the same number, expiry and PIN. Only for Active or Inactive cards | `data.shippingAddress` (req; US only) | Same shape; `cardId` unchanged; `last4Digits` unchanged; `type` physical |

Card lifecycle (from docs): Create → Active; Active ↔ Frozen; Active or Frozen → ClosedByCustomer, Stolen or Lost (all final); Active or Inactive → replace (same credentials).

### 4.8 Collections (8), intents, and payments under collections (5)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/collections | Create a collection (dues if `requestedAmount` set; donation/open amount if omitted) | `data.title` (req, max 50), `requestedAmount` (cents, min 100), `goalAmount` (display only), `recurringPaymentsEnabled` (default false) | `id`, `title`, `requestedAmount` (null for donations), `goalAmount`, `amountPaid` per the table (example shows `paidAmount`; see section 7), `payers`, `createdAt`, `descriptor` (`name`, `city`) |
| GET | /api/v1/chapters/{chapterId}/collections | List collections | `search` (title), `sort[field]` (name, createdAt), pagination | `data[]`: `id`, `title`, `requestedAmount`, `paidAmount`, `payers`, `createdAt` |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId} | Get a collection with totals | none | `id`, `title`, `requestedAmount`, `goalAmount`, `amountPaid`, `payers`, `createdAt`, `descriptor` |
| POST | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents | Create or update the intent that assigns a contact to pay. Auto-creates the contact by mobile. Returns 201 on create, 200 otherwise | Contact: `contactId` OR (`firstName`, `lastName`, `email`); `mobile` (opt; placeholder generated if absent), `dateOfBirth` (opt). `requestedAmount` (req, cents, min 100). `payerIp` (req). `userConsented` (req, must be true). `successUrl`, `failureUrl` (opt; placeholders `{collectionId}`, `{intentId}`, `{contactId}`, `{email}`). `paymentPlan` (opt: `type` Installment or Recurring; `timeInterval` Month or Year; `paymentsCount` opt; Installment up to 24 payments; Recurring up to 24 Month or 5 Year periods) | `id`, `contactId`, `requestedAmount`, `paidAmount`, `firstName`, `lastName`, `email`, `status`, `payments[]`, `successUrl`, `failureUrl`, `paymentUrl`, `paymentPlan`, `descriptor`, `createdAt` |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents | List intents for a collection | `search` (contact first or last name), `sort[field]` (name, status, createdAt), pagination | `data[]`: intent fields above (includes `payments[]`) |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId} | Get one intent | none | Intent fields plus `paymentPlan` |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/by-mobile/{mobileNumber} | Look up an intent by contact mobile (E.164) | none | Intent fields |
| PATCH | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId} | Update an intent. Donations can change `requestedAmount`; Dues cannot | `requestedAmount` (donations only), `successUrl`, `failureUrl`, `firstName`, `lastName`, `email`, `paymentPlan` (object or null to remove) | Intent object |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId}/payments | List payments for an intent | `sort[field]` (createdAt, amount, status), `sort[direction]` (default ASC per table, newest-first if no sort; see section 7), `filter[status][]`, `filter[method][]` | `data[]`: `id`, `uid` (deprecated), `method` (Card, Ach, Cash, Check, Wire, Other), `amount`, `fee`, `status`, `incompleteReason`, `scheduledPaymentId`, `cardScheme`, `cardType`, `methodLast4` (card only), `createdAt` |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId}/payments/{paymentId} | Get one payment (404 if not in the intent) | none | Same as list item |
| POST | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId}/payments/{paymentId}/refund | Refund a payment (asynchronous). Eligibility: status Succeeded; card method; within 30 days; no pending refund; not previously reversed; chapter banking enabled | `data.reason` (req, 1–500 chars) | `paymentId`, `status` (Processing), `refundAmount`, `originalAmount`, `feeAmount`, `feeCoveredByUser`, `refundedAt`. Final status via webhook |
| GET | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId}/payments/{paymentId}/refund-check | Check refund eligibility before refunding. Poll until `canProcess` is true | none | `isEligible`, `canProcess`, `reason`, `isPendingRefund`, `hasBeenReversed`, `isImmediateRefundEligible`, `refundAmount`, `originalPaymentAmount`, `feeAmount`, `feeCoveredByUser`, `raceConditionWarning`, `nextPaymentDate` |
| POST | /api/v1/chapters/{chapterId}/collections/{collectionId}/intents/{intentId}/payment-plans/stop-recurring | Cancel an active payment plan. Completed payments are not reversed | none | `intentId`, `collectionId`, `canceledAt` |

Intent status is a rollup of payments: Paid (at least one succeeded), Pending (in progress, none succeeded), Returned, Cancelled, Not Paid. Fixed-amount collections should read intent status; open-amount collections should read each payment's status and `paidAmount` (docs, Collections folder).

### 4.9 Collect Payments (1): cross-organization payment view

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| GET | /api/v1/collect-payments | List all collect payments across every organization and chapter the partner manages | `search`, `sort[field]` (createdAt, amount, status, method), `filter[status]`, `filter[method]`, `filter[createdAt][min|max]`, `filter[refundedAt]` (bool), `filter[organizationId]`, `filter[chapterId]`, `filter[hasUrls]` (bool), pagination | `data[]`: `id`, `method`, `methodLast4`, `cardScheme` (Visa, Mastercard, Amex, Discover, JCB, Diners Club), `status`, `amount` (includes fee), `standardAmount`, `fee`, `feeCovered`, `isReleased`, `releasedAt`, `releaseAccountId`, `isFeeTaken`, `feeTakenAt`, `currency`, `refundedAt`, `refundReason`, `incompleteReason`, `isRefunded`, `createdAt`, `updatedAt`, `collectRequest` (`id`, `title`, `type` Payment, Document, Fundraising or Goods, `organizationName`, `chapterName`), `organization`, `chapter`, `payer` (`id`, `firstName`, `lastName`, `email`), `intent` (`id`), `scheduledPayment` (`id`, `status`, `amount`, `fee`, `paymentDate`, `paymentPlan`) |

### 4.10 Counterparties (5): saved payees

Path uses `/api/v1/chapters/{chapterId}/counterparties` (the collection literally uses the placeholder `chapter_id`).

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/counterparties | Save an external bank account as a reusable recipient. Include an address to make it wire-eligible | `name` (req; persons need first and last name), `routingNumber` (req, 9 digits), `accountNumber` (req, 3–17), `accountType` (Checking or Savings), `type` (Person or Business), `nickname` (req, max 128), `address` (opt; `street` ≤100, `street2`, `city` ≤100, `state`, `postalCode`, `country` US only), `idempotencyKey` (req, UUID v4; "created at most once") | 201: `id` (numeric string), `type` (recipient), `nickname`, `name`, `accountLast4`, `routingNumber`, `accountType`, `entityType`, `hasAddress`, `address`, `wireEligible`, `managed`, `createdAt`. Full account number never returned |
| GET | /api/v1/chapters/{chapterId}/counterparties | List recipients and portal-linked accounts | `filter[type]` (recipient or linkedAccount), `filter[search]` (≤100), `pagination[limit]`, `pagination[offset]` | `counterparties[]` (same fields as Get); `meta.limit`, `meta.offset`, `meta.count`. 403 `COUNTERPARTIES_NOT_ENABLED` |
| GET | /api/v1/chapters/{chapterId}/counterparties/{counterpartyId} | Get one counterparty | none | `id`, `type`, `nickname`, `name`, `accountLast4`, `routingNumber`, `accountType` (Checking, Savings, Loan), `entityType`, `hasAddress`, `address`, `wireEligible`, `managed`, `createdAt` |
| PATCH | /api/v1/chapters/{chapterId}/counterparties/{counterpartyId} | Replace the mailing address (the only mutable field; enables wires) | `data.address` (full replacement; no partial updates) | Updated counterparty (same as Get) |
| DELETE | /api/v1/chapters/{chapterId}/counterparties/{counterpartyId} | Delete a recipient (linked accounts cannot be deleted here) | none | 204 No Content. 409 `DUPLICATE_REQUEST` if a delete is in flight |

### 4.11 Payments: origination (book, ACH, wire) and held-funds operations (13)

All origination requests POST to `/api/v1/chapters/{chapterId}/payments` with `data.type` selecting the variant. Quote and cancel are separate paths.

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/payments (type `book`) | Book transfers between the chapter checking account and contact accounts (wallet or perdiem). Continue-on-error; max 10 per request | `data.type` = `book`; `data.payments[]`: `sourceAccountId`, `destinationAccountId`, `amount` (int, cents, > 0), `description` (≤80), `idempotencyKey` (UUID). One side must be chapter checking | `chapterId`, `totalProcessed`, `successCount`, `failedCount`, `results[]`: `index`, `status` (success or failed), `paymentId`, `paymentStatus` (Pending, Sent, Rejected), `error`, `errorCode` |
| POST | /api/v1/chapters/{chapterId}/payments (type `ach`) | Originate one outbound ACH credit to inline bank details (exactly 1 per request) | `data.type` = `ach`; `payments[]`: `counterparty` (`name`, `routingNumber`, `accountNumber`, `accountType`, `type`), `amount` (min 100), `description` (≤10 ASCII, statement descriptor), `addenda` (≤80 ASCII), `sameDay` (opt), `applyFee` (req bool), `idempotencyKey` (UUID; ~48h window) | 201: `id`, `method` (ach), `status` (pending), `amount`, `description`, `addenda`, `sameDay`, `counterparty` (`name`, `accountLast4`, `accountType`), `fee` (`status`, `amount`, `feeType`), `totalDebit`, `returnReason`, `createdAt` |
| POST | /api/v1/chapters/{chapterId}/payments (type `achCounterparty`) | ACH credit to a saved counterparty (recipient or linkedAccount). Reads back as `method: "ach"` | `data.type` = `achCounterparty`; `payments[]`: `counterpartyId` (req), `amount`, `description`, `addenda`, `sameDay`, `applyFee`, `idempotencyKey` | Same as ACH, plus `counterpartyId` |
| POST | /api/v1/chapters/{chapterId}/payments (type `wire`) | Originate one outbound wire to inline bank details and a recipient address (exactly 1) | `data.type` = `wire`; `payments[]`: `counterparty` (as ACH, plus `address` req: `street`, `street2`, `city`, `state`, `postalCode`, `country`), `amount` (min 10000), `description` (≤50 ASCII), `applyFee`, `idempotencyKey`. No `sameDay` or `addenda` | 201: `id`, `method` (wire), `status` (pending), `amount`, `description`, `counterparty`, `fee`, `totalDebit`, `returnReason`, `createdAt` |
| POST | /api/v1/chapters/{chapterId}/payments (type `wireCounterparty`) | Wire to a saved counterparty that has a stored address (`wireEligible: true`) | `data.type` = `wireCounterparty`; `payments[]`: `counterpartyId`, `amount` (min 10000), `description` (≤50), `applyFee`, `idempotencyKey` | Same as wire, plus `counterpartyId` |
| POST | /api/v1/chapters/{chapterId}/payments/release-funds | Move held collection funds to the chapter deposit account (requires fund holding). Rejections return 201 with `Rejected` | `amount` (req, int cents), `idempotencyKey` (opt) | `chapterId`, `sourceAccountId`, `destinationAccountId`, `amount`, `transactionId`, `status` (Pending, Sent, Rejected), `reason`, `reasonCode` (InsufficientFunds, AccountClosed, AccountFrozen, Unknown; new codes possible) |
| POST | /api/v1/chapters/{chapterId}/payments/move-fees | Move fees from held collection funds to a partner account (requires fund holding) | `destinationAccountId` (req), `amount` (req), `idempotencyKey` (opt) | Same as release-funds |
| POST | /api/v1/chapters/{chapterId}/payments/platform-charges | Collect a platform charge from a chapter deposit account | `sourceAccountId` (req), `amount` (req), `description` (req), `idempotencyKey` (req) | `chapterId`, `sourceAccountId`, `amount`, `transactionId`, `status`, `reason`, `reasonCode` |
| GET | /api/v1/chapters/{chapterId}/payments | List origination payments (not collection payments or held-funds operations) | `filter[method]` (book, ach, wire), `filter[status]` (pending, processing, sent, returned, canceled, failed), `pagination[limit]`, `pagination[offset]` | `payments[]` (same as Get); `meta.limit`, `meta.offset`, `meta.count`. Fee is indicative in list (billing type only) |
| GET | /api/v1/chapters/{chapterId}/payments/{paymentId} | Get one origination payment (live status) | none | `id`, `method`, `status`, `amount`, `description`, `addenda`, `sameDay`, `counterpartyId` (when saved counterparty), `counterparty` (`name`, `accountLast4`, `accountType`), `accounts` (`sourceAccountId`, `destinationAccountId`; book only), `fee` (`status` charged, failed, partner_billed or none; `amount`; `feeType`), `totalDebit`, `returnReason` (R01 to R85), `createdAt` |
| POST | /api/v1/chapters/{chapterId}/payments/{paymentId}/cancel | Cancel a payment before it settles. ACH: only while pending. Wire: while pending (including under review), funds credited back. Book: never | none | Canceled payment (same shape as Get; `status: "canceled"`). 400 `CANNOT_CANCEL` |
| POST | /api/v1/chapters/{chapterId}/payments/quotes/ach | Price an ACH before sending. Side-effect free; no key needed | `amount` (min 100), `applyFee` (default true), `sameDay` (default false), `counterpartyId` OR (`routingNumber`, `accountNumber`) | `type`, `amount`, `applyFee`, `fee` (`feeType`, `amount`, `waiverApplied`, `convertsToInstantTransfer`, `calculationRules[]`), `totalDebit`, `eligibility` (`sameDayAchSupported`, `minAmount`), `balance` (`sufficient`), `returnFee` (`feeType`, `calculationRules`), `quotedAt` |
| POST | /api/v1/chapters/{chapterId}/payments/quotes/wire | Price a wire before sending. Side-effect free | `amount` (min 10000), `applyFee`, `counterpartyId` OR `routingNumber` | `type`, `amount`, `applyFee`, `fee` (as ACH, without the instant flag), `totalDebit`, `eligibility` (`wireSupported`, `minAmount`), `balance` (`sufficient`), `returnFee`, `quotedAt` |

The release-funds, move-fees and platform-charges endpoints are the only held-funds operations. Origination webhooks: `finance.ach_payment.*` and `finance.wire_payment.*` (section 5).

### 4.12 Transactions (2): read-only ledger

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| GET | /api/v1/chapters/{chapterId}/transactions | List ledger transactions across the chapter's accounts | `search` (title, type, summary, external ID), `sort[field]` (createdAt, amount, direction, type), `filter[direction]` (Credit or Debit), `filter[amount][min|max]`, `filter[createdAt][min|max]`, `filter[type]` (e.g. purchaseTransaction), `filter[accountId]`, pagination | `data[]`: `id` (number), `accountId`, `type` (purchaseTransaction, bookTransaction, achTransaction, wireTransaction, feeTransaction, and card types), `direction`, `amount`, `title`, `summary`, `createdAt`, `category`, `cardId` (card types), `transactionTags[]` (`id`, `name`), `counterparty` (book only: `accountId`, `product`, `contactName`), `collectPaymentId`, `collectRequestId`, `collectIntentId` (fund-release reconciliation) |
| GET | /api/v1/chapters/{chapterId}/accounts/{accountId}/transactions | Same, scoped to one account | As above, without `filter[accountId]` | Same as chapter list |

### 4.13 Embedded tokens (1)

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/chapters/{chapterId}/contacts/{contactId}/embedded-token | Create a short-lived JWT scoped to one contact, for embedded Crowded UI. Generating a new token invalidates the previous one. Server-side only | none (uses `partner_jwt`) | `accessToken`, `tokenId`, `expiresIn` (seconds) |

### 4.14 Webhooks (11): registrations, event types, and deliveries

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/webhooks | Register an HTTPS endpoint | `url` (req, HTTPS; no localhost, private IPs or metadata hosts), `events` (req; `["*"]` = snapshot of all types at save time), `deliveryMode` (`at_least_once` default, or `at_most_once`), `description` (≤500), `secret` (opt, 32–128 chars of `[A-Za-z0-9_\-+/=]`; generated if absent), `authorizationHeader` (opt, ≤2048) | `id`, `url`, `events`, `deliveryMode`, `description`, `isActive` (true), `hasAuthorizationHeader`, `secret` (returned only on create), `authorizationHeader` (only on create), `createdAt`, `updatedAt` |
| GET | /api/v1/webhooks | List registrations | `sort[field]` (createdAt, url, isActive), `sort[direction]`, pagination | `data[]`: `id`, `url`, `events`, `deliveryMode`, `description`, `isActive`, `hasAuthorizationHeader`, `createdAt`, `updatedAt` |
| GET | /api/v1/webhooks/{webhookId} | Get one registration | none | Same as list item |
| PATCH | /api/v1/webhooks/{webhookId} | Update a registration (at least one field). `events` replaces the list (snapshot) | `url`, `events`, `deliveryMode`, `description` (null or empty clears), `isActive`, `authorizationHeader` (null removes) | Registration object |
| DELETE | /api/v1/webhooks/{webhookId} | Soft-delete a registration. In-flight deliveries may still complete. Not reversible | none | 204 No Content |
| GET | /api/v1/webhooks/event-types | List subscribable event types (public, no auth) | none | `events[]` (flat list), `byNamespace` (`collect`, `platform`, `finance`), `wildcardSupported` (true) |
| GET | /api/v1/webhooks/{webhookId}/events | List deliveries for a registration | `sort[field]` (createdAt, status, eventType), `sort[direction]`, `filter[status]` (pending, processing, delivered, failed, dlq), `filter[eventType]`, pagination | `data[]`: `id`, `eventType`, `eventId`, `status`, `attempts`, `nextRetryAt`, `deliveredAt`, `createdAt` |
| GET | /api/v1/webhooks/{webhookId}/events/{eventId} | Get one delivery with attempt history | none | Delivery fields plus `deliveryAttempts[]` (most recent first): `attemptNumber`, `statusCode`, `responseBody` (truncated to 10 KB), `requestDurationMs`, `errorMessage`, `errorCode` (e.g. ECONNREFUSED), `attemptedAt` |
| POST | /api/v1/webhooks/{webhookId}/events/{eventId} | Re-queue a failed or dlq delivery for immediate redelivery | none | 202 Accepted. 400 if not retryable (delivered events cannot be retried). Attempt counter is not reset |


### 4.15 Sandbox (5): test-only simulators

Documented as sandbox-only; production returns 404.

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| POST | /api/v1/sandbox/card-purchases | Simulate a card purchase on a card (triggers `finance.transaction.created`) | `cardId` (req), `amount` (cents, > 0), `direction` (Credit or Debit), `merchantName` (≤200), `merchantType` (4-digit MCC), `merchantLocation` (≤200, opt), `merchantId` (opt, exactly 15 chars), `coordinates` (opt: `longitude`, `latitude`) | `id` (number), `type` (purchaseTransaction), `direction`, `amount`, `cardId`, `title`, `summary`, `createdAt` |
| POST | /api/v1/sandbox/card-authorizations | Simulate a card authorization (triggers `finance.authorization.created` or `.declined`) | `cardId`, `amount`, `merchantName`, `merchantType`, `merchantLocation`, `merchantId`, `recurring` (default false), `status` (Authorized default, or Declined) | Authorization shape (`id`, `accountId`, `cardId`, `amount`, `status`, `declineReason` on decline, `recurring`, `createdAt`, `merchant`) |
| POST | /api/v1/sandbox/card-authorizations/{authorizationId}/increase | Increase the held amount of a simulated authorization (triggers `finance.authorization.amount_changed`) | `amount` (req, > 0), `recurring` (req) | Authorization with the post-increase amount |
| POST | /api/v1/sandbox/card-authorizations/{authorizationId}/cancel | Cancel a simulated authorization (triggers `finance.authorization.canceled`) | none | Authorization with `status` Canceled |
| POST | /api/v1/sandbox/payments/{paymentId}/simulate | Drive an ACH or wire origination through a status change (emits `finance.ach_payment.*` or `finance.wire_payment.*`) | `status` (processing, sent, returned, canceled, failed), `returnReason` (ACH return code, default R01 for returned) | Payment resource with the simulated status. 400 for an unreachable status (for example `processing` on a wire) or a book payment |

---

## 5. Webhooks and events

### 5.1 Delivery and envelope
- Every delivery is a batch, even for one event: `{ "batchId": "<uuid>", "count": n, "events": [ { "eventId", "eventType", "version": "1.0", "timestamp", "context": { "partnerId", "organizationId", "chapterId" }, "data": {...} } ] }`.
- Headers: `Content-Type: application/json`, `X-Webhook-Batch` (batch id), `X-Webhook-Batch-Count`, `X-Webhook-Signature: sha256=<hex>`, `X-Webhook-Attempt` (1, 2, 3…), `User-Agent: Crowded-Webhooks/1.0`, and `Authorization` (custom value, if configured).
- The endpoint must respond with 2xx within 30 seconds.
- Duplicates are possible. Deduplicate on `eventId`. Ordering is not guaranteed. The ACH and wire payment events are "at-least-once and unordered": treat the payload as a hint and call Get Payment for current state.

### 5.2 Signature verification (conflicting guidance)
- Overview: "Verify by computing HMAC-SHA256 of the raw request body (JSON string) using your webhook secret." The signature covers the whole batch.
- Event Types example code computes HMAC over `JSON.stringify(payload)` after parsing. These can differ if key order or whitespace changes.
- Recommendation: verify over the raw bytes. The docs do not settle this; confirm with Crowded.
- No timestamp is included in the signature header, so replay protection is not documented.

### 5.3 Retry policy (at_least_once only)
- Failures are retried with exponential backoff (1s, 2s, 4s…) up to a 1-hour cap, then hourly, for up to about 48 hours.
- After retries are exhausted, the event moves to the dead-letter queue (`dlq`) and can be retried manually.
- Statuses: `pending`, `processing`, `delivered`, `failed` (will retry), `dlq`.
- `at_most_once`: one attempt, no retries.
- Registrations do not receive event types added later unless re-saved with `["*"]` or updated explicitly.

### 5.4 Event catalog

Listed in the Get Event Types example (39 types):

- **collect:** `collect.collection.created`, `collect.collection.updated`, `collect.collection.canceled`; `collect.payment.pending`, `collect.payment.processing`, `collect.payment.succeeded`, `collect.payment.failed`, `collect.payment.canceled`, `collect.payment.returned`, `collect.payment.refunded`; `collect.payment_plan.created`, `collect.payment_plan.canceled`, `collect.payment_plan.completed`; `collect.refund.initiated`, `collect.refund.processing`, `collect.refund.reversed`; `collect.intent.created`, `collect.intent.updated`.
- **platform:** `platform.organization.created`, `.updated`, `.archived`; `platform.chapter.created`, `.updated`, `.archived`; `platform.contact.created`, `.updated`, `.archived`; `platform.contacts.bulk_created`.
- **finance:** `finance.account.created`, `.updated`, `.closed`; `finance.application.submitted`, `.approved`, `.denied`; `finance.transaction.created`; `finance.authorization.created`, `.declined`, `.canceled`, `.amount_changed`.

Documented but missing from that 39-item example list:

- `finance.ach_payment.processing`, `finance.ach_payment.sent`, `finance.ach_payment.returned`, `finance.ach_payment.canceled`, `finance.ach_payment.failed`
- `finance.wire_payment.sent`, `finance.wire_payment.returned`, `finance.wire_payment.canceled`, `finance.wire_payment.failed`

Registrations created before these types existed do not get them until updated or re-saved with `["*"]`. Whether the example list or the event docs are authoritative is UNCONFIRMED.

### 5.5 Key payloads (selected)
- **collect.payment.\*:** `paymentId`, `intentId`, `collectionId`, `contactId`, `amount` (net, what the org receives), `fee`, `method` (lowercase), `status` (lowercase), `failureReason`, `refundReason`, `refundDetailId`, `feeRefunded`, `plan` (`planId`, `type`, `frequency`, `paymentNumber`, `totalPayments`, `remainingBalance`, `nextPaymentDate`). The ACH flow: `pending` → `processing` → `succeeded` → optionally `returned`. Card payments do not emit pending, processing, canceled or returned.
- **collect.payment.failed:** emitted for ACH cancellations and returns, in addition to the specific event. Subscribers to both get two events with different `eventId`s. Apply the unsuccessful outcome once per `paymentId`.
- **collect.refund.\*:** `refundId`, `paymentId`, `intentId`, `collectionId`, `contactId`, `amount`, `status`, `reason`, `reversalReason`.
- **collect.payment_plan.\*, collect.intent.\*, collect.collection.\*:** plan, intent and collection shapes respectively (collection: `collectionId`, `chapterId`, `title`, `type` dues, donation or goods, `requestedAmount`, `status` active, paused, canceled or completed, `isAmountEditable`, `startDate`, `endDate`).
- **finance.account.\*:** `accountId`, `chapterId`, `accountType`, `status`, `createdAt`.
- **finance.application.\*:** `applicationId`, `chapterId`, `type`, `status`, `denialReason`, `submittedAt`, `decidedAt`, `createdAt`.
- **finance.transaction.created:** mirrors the `GET .../transactions` item. Idempotency key is `(transactionId, accountId)`. A book transfer between two chapter accounts sends two events with the same `transactionId` and different `accountId`. Events fire only for chapter-owned accounts.
- **finance.authorization.\*:** same shape as the authorization read endpoints. `cardLast4Digits` is deliberately excluded.
- **finance.ach_payment.\* / finance.wire_payment.\*:** the same payment resource as the Get Payment endpoint.
- **platform.organization.\*:** `organizationId`, `name`, `status` (active, inactive or archived), `createdAt`, `updatedAt`, `partnerInvitationId` (set when created via an onboarding link).
- **platform.chapter.\*:** `chapterId`, `organizationId`, `name`, `createdAt`, `updatedAt`. Reconcile via `partnerInvitationId` if the chapter came from a link.
- **platform.contact.\*:** `contactId`, `chapterId`, and contact fields. **platform.contacts.bulk_created:** `chapterId`, `count`.

### 5.6 Event management
- `GET /api/v1/webhooks/{id}/events` and `GET .../events/{eventId}` expose delivery history (attempts with status codes and response bodies). Use them to debug failures.
- `POST .../events/{eventId}` re-queues failed or dlq events.

---

## 6. Sandbox and testing

- **Host:** `sandbox-api.crowdedfinance.com`. The Sandbox folder says the simulators exist in "non-production environments (staging, dev)". Whether the simulators are on the sandbox host only is UNCONFIRMED.
- **Test credentials process:** UNCONFIRMED. No sign-up, key request, or sandbox partner account process is documented. Support is "support@bankingcrowded.com" for API access requests.
- **Magic values and fixtures:** none documented. The docs do not list any test card numbers, test bank routing or account numbers, test SSNs, or test EINs that trigger specific outcomes. Example values in request bodies (for example `812345678` routing, SSN-shaped strings) are illustrative and their sandbox behaviour is UNCONFIRMED.
- **Simulators available:** card purchases; card authorizations (Authorized or Declined; decline reason chosen upstream); authorization increase and cancel; origination payment status changes (processing, sent, returned with an ACH return code, canceled, failed).
- **Simulators not available:** collection payments (no way to simulate a card or ACH collection success, failure or return), refunds, applications and approval decisions, KYB outcomes, fund release, subaccount owner onboarding, deposit account creation, webhook test delivery.
- **Webhook testing:** triggered indirectly through the simulators. Each simulator states which event it fires. A "send test event" endpoint is not documented.
- **Deterministic errors:** the docs refer to "well-known fixtures" ("Verify partner integration error handling against well-known fixtures") but no fixtures are listed.

---

## 7. Gaps and questions for the integrator

**Auth and environments**
1. Production base URL: not documented.
2. How a `partner_jwt` is issued, its lifetime, refresh and scopes. What `api_token` is, and whether it is the same credential. The relationship between the "API key" (cited for rate limits) and the bearer token.
3. Sandbox credential process and whether sandbox and production share a partner identity.
4. Whether an embedded token's `expiresIn` has a fixed maximum.

**Idempotency and retries**
5. Idempotency is body-level only, and several create endpoints (organizations, chapters, contacts, collections) have none. Retrying those may create duplicates.
6. Behaviour when an idempotency key is reused with a different body, and key retention windows beyond the ~48h for ACH and wire.

**Rate limits and errors**
7. Rate-limit headers and the response on exceeding 1,000/min are not documented. Bulk caps are inconsistent: the general rule is 100, but specific endpoints cap at 10 or 1.
8. No complete error-code catalogue. Retry guidance for 5xx responses is not documented.

**Money and identifiers**
9. `standardAmount` (collect payments): whole dollars or decimal dollars?
10. Collect payment `amount` is gross in REST ("includes fee") but net in the webhook ("what org receives"). Confirm the rule.
11. Subaccount bulk-fund `amount` unit and minimum.
12. ID types are mixed (UUID, numeric string, number). Confirm which are stable and whether any are safe to parse.
13. `amountPaid` (table) vs `paidAmount` (example) on Collections. `requestedAmount` for donations is documented as `null` but the list example shows `0`.
14. Collection payment `sort[direction]` default: the table says ASC, while the text says newest-first if no sort is given.

**KYC/KYB and people**
15. KYB process for organizations and chapters: which documents, timelines, and how review outcomes arrive (the `finance.application.*` events and `AwaitingDocuments` status are the only signals documented).
16. Officer identity: the Submit request example includes `officer.dateOfBirth` and `officer.email`, which are not in the documented field table. SSN is accepted in the request body. Confirm handling, storage and log redaction expectations.
17. Member (contact) identity: placeholder-mobile contacts cannot use OTP or SMS. There is no documented contact verification endpoint or status beyond Active, Failed and Archived.
18. Account numbers: Accounts list and get document `accountNumber` as the bank account number, and the example is unmasked. Counterparties return last 4 only. Confirm whether the account number is intentionally exposed and what PCI or PII controls apply.

**International and FX**
19. Everything is US-only in the docs: addresses (counterparties, wires, card shipping, officer address), ABA routing numbers, USD amounts. No IBAN, SWIFT, non-US cardholder or FX endpoints are documented. Treat as unsupported unless confirmed.

**Cards**
20. No endpoint to change limits, MCC rules or spend controls (limits are read-only on the card read endpoints).
21. No PIN set or reset endpoint (`pinStatus` is read-only).
22. No activation endpoint for physical cards, although `Inactive` is a status and replacement says "does not require activation".
23. No endpoint to retrieve full PAN or CVV. Whether this is intentionally handled through embedded UI is UNCONFIRMED.
24. `Create Cards` returns 200 even when items fail. Retry behaviour depends on per-item keys.

**Accounts and money movement**
25. No account create beyond wallet or perdiem via bulk; no close, freeze or unfreeze endpoint for deposit accounts.
26. No ACH debit (pulling funds) through the API. Collections use hosted payment pages instead.
27. Wire cancel semantics for funds already credited, and ACH return handling beyond the webhook, are described only briefly.
28. Quote endpoints do not reserve funds. Balance sufficiency is a point-in-time check.

**Documents and other products**
29. No statements, tax forms (1099), receipts, document download, or bill-pay endpoints are present. The Application docs mention document upload, which happens through the hosted form only.
30. No invoice object separate from collections and intents.

**Webhooks**
31. Signature guidance conflicts (raw body vs `JSON.stringify`). No timestamp in the signature, so no replay window is documented.
32. ACH and wire payment events are documented but absent from the 39-item enumerated list.
33. `collect.refund.completed` status exists in the refund event data, but no `collect.refund.completed` event is listed. How completion is signalled is UNCONFIRMED.
34. Maximum batch size, maximum payload size, and ordering guarantees are not documented.
35. Snapshot semantics for `["*"]` mean new event types need an explicit update. Consider whether to subscribe explicitly.

**Pagination and naming**
36. Two pagination shapes (`meta.pagination` and `meta.limit`/`count`), plus two parameter styles (`page` and `offset`). Sort default is `DESC` in examples and `desc` in some responses.
37. Enum casing differs by surface (see section 3.10). "Cancelled" (collections) vs "canceled" (origination and webhooks). Method enums differ across three surfaces.

**Document quirks (not blocking, but noted)**
38. Archive webhook registration shows a copy-pasted request body (`events`, `deliveryMode`) that does not apply to DELETE.
39. Several collection item names use a literal `chapter_id` in the path rather than a variable.
40. Some doc links refer to "/v1/..." paths (for example the transaction event note) rather than "/api/v1/...".
41. Some endpoints document `Authorization: Bearer {{partner_jwt}}` while others rely on the collection `api_token`; the docs do not say which applies.

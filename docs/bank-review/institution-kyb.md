# Institution KYB: what we check before an institution's money moves

Status: proposal for the bank's review · Prepared 2026-10-20 · Requirements REQ-INS-010 to REQ-INS-014 · Decision record ADR-017

This is research and a proposed control design, not legal advice. Items marked **[recent]** changed in
2025–2026. Items marked **[verify]** rest on a secondary source or an unofficial translation; we ask the bank to
confirm them. The questions at the end are the bank's to answer. Kesher will not settle them alone.

## Why this exists

Institutions are schools: Israeli yeshivot and seminaries, usually amutot or public-benefit companies (חל"צ),
and US day schools, usually 501(c)(3) nonprofit corporations. Each has its own ledger account
(T-0613). Money moves through it in four ways:

- **Deposits:** it pays in by Masav, wire or ACH (REQ-INS-007, REQ-INS-009).
- **Allowances:** it pays students from its balance (REQ-INS-003).
- **Credit:** it may run allowances on a credit line that two admins approve (REQ-INS-008).
- **Payouts:** it pays out to its own bank account (REQ-PO-001).

Its staff are individual members who already passed individual KYC. Today nothing checks the *institution*
itself. This document sets out that check (KYB) and which capability each outcome unlocks.

## Who owns the obligation

### United States

- **The rule binds the sponsor bank.** FinCEN's customer due diligence (CDD) rule, 31 CFR 1010.230, binds
  banks and other "covered financial institutions". It does not bind money services businesses.
- **Kesher runs the process.** The 2016 interagency prepaid guidance treats a program manager as the bank's
  agent for customer identification. In practice the bank sets the standard and Kesher runs it.
- **If Kesher holds a money-transmitter licence, it has its own duty.** Its AML program must then include
  customer verification under 31 CFR 1022.210(d)(1)(i)(A).
- **Nonprofits need a control person, not owners.** A nonprofit organised under state law needs no 25% owners,
  but one verified control person (§1010.230(e)(3); FinCEN CDD FAQ E.6, May 2026). This holds whether or not
  the nonprofit is tax-exempt.
- **Unincorporated schools fall outside the rule.** An unincorporated association, such as some synagogue-run
  schools, is not a "legal entity customer" (FAQ E.4). It still needs the bank's identity checks, and the
  bank decides how.
- **The Corporate Transparency Act no longer applies to US schools [recent].** FinCEN's final rule (2026-08-14)
  exempts US companies and US persons from beneficial-ownership (BOI) reporting. It deletes data already
  filed, so the BOI database cannot be a source.
- **The CDD rule itself is unchanged.** Order FIN-2026-R001 (2026-02-13) lets a bank collect beneficial owners
  only at first account opening, when there is doubt, or when its procedures call for it.

### Israel

Two laws apply: the Prohibition on Money Laundering Law 5760-2000 and the Prohibition on Terror Financing Law
5765-2005. Which order applies depends on how Kesher operates:

- **Through an Israeli bank.** The bank applies the Banking Corporations Order 5761-2001 and Directive 411.
  Directive 411 was updated on 2026-04-30 (Circular 2843) **[recent]**. The same circular exempts banks from
  collecting controlling-person declarations on accounts that licensed payment companies hold for their
  clients, which moves that work to the payment company.
- **Under Kesher's own Israel Securities Authority payment licence.** Kesher applies the 2024 money-laundering
  order for payment companies itself. When that order takes effect depends on the authority's remote-
  identification directives **[verify]**.
- **An amuta has no shareholders.** Its controlling persons are the board chair and the CEO
  **[verify: AML Law §7(a)(1)(b)]**. We declare both, list every board (vaad) member, and put each through
  individual KYC.

## What we collect

1. Legal name, Hebrew and English names, and any trade names.
2. Identifiers: in Israel, the amuta number (58xxxxxxx) or the חל"צ number; in the US, the EIN with the state
   and date of formation.
3. Entity type: amuta, חל"צ, nonprofit corporation, unincorporated association, or a church-run school.
4. Registered and operating addresses.
5. Formation documents: in Israel, the registration certificate (תעודת רישום) and articles (תקנון); in the US,
   the articles and bylaws.
6. Evidence of existence: in Israel, the registry or an attorney's certificate; in the US, Secretary of State
   good standing.
7. Tax status:
   - **Israel:** the ניהול תקין (proper management) certificate for the current year, or why it is absent;
     the §46 donation-credit letter if there is one.
   - **US:** the IRS determination letter, the CP 575 or Letter 147C, or a church-status attestation.
8. Governance:
   - every board or vaad member and their role;
   - the control person (US) or controlling persons (Israel: chair and CEO);
   - the authorised signatories and the signing rule, for example two of five.
9. Board resolutions, which may be one protocol:
   - to open the Kesher account;
   - naming the signatories and the institution's Kesher admins;
   - for credit, authorising borrowing up to the limit.
10. A signed controlling-person and beneficiary declaration: Israel's form, or the US CDD certification.
11. Nature and purpose:
    - students, and the expected number of allowance recipients;
    - expected monthly deposits and payouts;
    - funding sources (tuition, donations, government, foreign), and the countries funds come from;
    - whether it handles cash.
12. Its own-name bank account for deposits and payouts, with proof: in Israel, the bank's account-ownership
    confirmation (אישור ניהול חשבון); in the US, a bank letter or voided check.
13. For a credit line: the last audited financials, or the report filed with the Registrar or the Form 990.

## What we check automatically

| Check | Israel | United States |
|---|---|---|
| A1 Registry status | `moj-amutot` shows the amuta registered (רשומה), or `ica_companies` shows the חל"צ active. Both are free data.gov.il datasets. | Secretary of State active and in good standing, through a vendor |
| A2 Identifier match | The registry's number and name match what was given | IRS name/EIN match |
| A3 Exempt status | ניהול תקין for the current or prior year | Pub 78 or the IRS master file, checked against the auto-revocation list. A school not found may be a church, so it goes to manual review, never an automatic fail. |
| A4 Sanctions | The institution, its names, and every board member, control person and signatory, screened against OFAC (with the 50% rule), the UN lists, Israel's terror-designation list (NBCTF), and any others the bank requires | The same |
| A5 PEP and adverse media | The same people | The same people |
| A6 Individual KYC | Every control person has passed T2; every signatory and staff admin has passed T1 or T2 | The same |
| A7 Account ownership | The payout account's owner matches the registered name | The same |
| A8 Foreign state funding | The amuta's entry in the registry's foreign-state donation data. This informs the risk rating only. | Not applicable |
| A9 Risk rating | Computed from the above | The same |

None of the free Israeli datasets list board members or signatories. Those come from the institution's protocol
or an attorney's certificate.

## What compliance reviews by hand

- **M1.** Read the articles or bylaws: the purpose, the signing rule, and any power to borrow.
- **M2.** Test the controlling-person declaration for plausibility against the registry extract and the
  protocol.
- **M3.** Dispose of every screening hit as a false positive or a true match, with a note.
- **M4.** Decide exceptions: a US church or unincorporated school missing from IRS data; an amuta without ניהול
  תקין, for example one younger than two years.
- **M5.** Run enhanced due diligence when a trigger below fires.
- **M6.** For a credit line, review the financials and recommend a limit. The two-admin approval of REQ-INS-008
  follows.
- **M7.** A second reviewer approves every high-risk institution.

## Outcomes and what each unlocks (REQ-INS-010)

| Decision | Deposits post | Allowances from balance | Credit line | Payouts |
|---|---|---|---|---|
| **Needs more info** (the starting state) | No. A recorded deposit stays pending and is not credited. | No | No | No |
| **Approved with limits** (medium or high risk, an open exception, or a refresh overdue) | Yes | Yes | No | Yes, to the verified own-name account only |
| **Approved** | Yes | Yes | Eligible, after M6 and two admins | Yes, to the verified own-name account only |
| **Rejected** | No. Funds go back to their source as the bank instructs. | No | No | No. The final balance is handled as the bank and any suspicious-activity decision require. |

A refused action answers `FEATURE_OFF` and names the KYB status, so the console can say what is missing.

## Risk factors and enhanced due diligence triggers

FATF Recommendation 8, revised in November 2023, calls for focused, proportionate measures for nonprofits, and
calls blanket de-risking of nonprofits bad practice. We do not rate every yeshiva high risk.

Enhanced due diligence applies when any of these fires (our proposal; the bank may set its own):

- money comes in from an account not in the institution's name;
- a foreign wire comes from a FATF high-risk or monitored jurisdiction;
- monthly deposits exceed twice the declared volume;
- a requested credit limit exceeds one month of declared allowances;
- a PEP sits on the board or vaad (for example a rabbi who is also a council member);
- there is no ניהול תקין certificate, or a US school is missing from IRS data;
- adverse media appears;
- the signatories or the payout account change often.

A payout to an account in another name is refused outright (REQ-INS-012).

## Keeping it current (REQ-INS-013, REQ-INS-014)

- **Daily:** sanctions rescreen of the institution and every person in its record. An open potential match
  stops payouts and any allowance run that would draw on credit.
- **Weekly:** registry-status poll.
- **Monthly:** the IRS auto-revocation file.
- **Yearly:** ניהול תקין, after the Registrar's cycle.
- **Full refresh:** every 12, 24 or 36 months for high, medium or low risk. This is our proposal; neither
  country's law fixes a period. An overdue refresh drops the decision to approved with limits.
- **Re-review triggers:**
  - a change of signatories, board members or control person;
  - a registry status change, an IRS revocation, or loss of ניהול תקין;
  - a sanctions, PEP or adverse-media hit;
  - activity outside the declared profile;
  - a new foreign funding source from a high-risk country, or a third-party depositor;
  - a request to raise the credit limit, or a change of payout account;
  - a request from the bank or a regulator.

## How it is built

The plan follows the repo's rule that ports come before vendors:

- A `KybPort` with a simulator comes first, and every check writes its evidence to an insert-only record.
- Vendors bind to the port behind the `institutions.kyb.checks` flag once the bank has answered the questions
  below:
  - in Israel, the free data.gov.il registry APIs;
  - in the US, one KYB vendor (Middesk or Persona) plus an exempt-status source (Persona's nonprofit report
    or Candid Charity Check);
  - one screening provider covering OFAC, the UN lists, NBCTF and PEPs.
- Cards T-0619 to T-0624 and T-0926 build it.

## Questions for the bank

1. Who is the bank's identified customer for an institution's account: the institution, with Kesher as agent,
   or Kesher's pooled account? Does Kesher's process count as the bank's own customer identification?
2. Does the bank accept the control-person-only test for nonprofits? What evidence does it need for church-run or
   unincorporated schools that are missing from IRS data?
3. Which sanctions lists (OFAC, UN, EU, UK, NBCTF), at what match threshold, and how often to rescreen?
4. Israel: does Kesher operate under the bank (Banking Corporations Order and Directive 411) or under its own
   payment licence (the 2024 payment-companies order)? Has that order taken effect for Kesher?
5. Must the controlling-person declaration carry a wet-ink signature, or is a verified e-signature enough? Does
   the bank have its own form?
6. Who is the lender for institution credit lines, and which credit policy or licensing applies?
7. May third parties deposit into an institution's account (donors, parents, "friends of" charities)? If so,
   how must they be verified?
8. Which risk-rating method and refresh periods does the bank require? Does it sign off on high-risk
   institutions?
9. Must payouts go only to own-name accounts, and what proof of ownership does the bank accept? *Until the bank answers,
   Kesher pays institutions out only to their own verified account, which takes two compliance members to set or change
   (T-0623). Suppliers are paid by the institution, not through Kesher.*
10. What is the escalation path and timing for suspicious-activity reports, and who decides closure and the
    return of funds?
11. How long must records be kept, and does the bank need audit access to the KYB file and vendor evidence?

## Sources

- 31 CFR 1010.230 (CDD rule): https://www.law.cornell.edu/cfr/text/31/1010.230
- 31 CFR 1022.210 (MSB AML programs): https://www.law.cornell.edu/cfr/text/31/1022.210
- FinCEN CDD FAQs, consolidated May 2026: https://www.fincen.gov/system/files/2026-05/CDD-Rule-Consolidated-FAQs.pdf
- FinCEN Order FIN-2026-R001: https://www.fincen.gov/system/files/2026-02/FinCEN-Order-CCDExceptiveRelief.pdf
- BOI final rule, 2026-08-14: https://www.federalregister.gov/documents/2026/08/14/2026-16576/beneficial-ownership-information-reporting-requirement-revision
- Interagency prepaid CIP guidance (2016): https://www.fincen.gov/system/files/shared/InterAgencyGuidance20160318.pdf
- FinCEN ruling FIN-2012-R003: https://fincen.gov/sites/default/files/administrative_ruling/FIN-2012-R003.pdf
- IRS, organizations not required to file Form 1023: https://www.irs.gov/charities-non-profits/charitable-organizations/organizations-not-required-to-file-form-1023
- IRS Pub 1828: https://www.irs.gov/pub/irs-pdf/p1828.pdf
- IRS Tax Exempt Organization Search bulk data: https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads
- IRS automatic revocation FAQs: https://www.irs.gov/pub/irs-tege/auto_rev_faqs.pdf
- OFAC FAQ 401 (50% rule): https://ofac.treasury.gov/faqs/401
- Banking Corporations Order 5761-2001, unofficial Bank of Israel translation: https://www.gov.il/BlobFolder/dynamiccollectorresultitem/law-orders-banking-english/he/legal-docs_law_orders_banking_english.pdf
- Bank of Israel Circular 2843 (Directive 411, 2026-04-30): https://www.boi.org.il/media/k1jfgtrq/h2843.pdf
- Payment-companies AML order 2024 (law-firm summary): https://herzoglaw.co.il/en/news-and-insights/a-new-anti-money-laundering-order-for-payment-companies-and-a-draft-directive-regarding-online-identification-technology/
- data.gov.il amutot dataset: https://data.gov.il/dataset/moj-amutot
- data.gov.il companies dataset: https://data.gov.il/dataset/ica_companies
- Association extract (gov.il): https://www.gov.il/he/service/association_extract
- Knesset bill on proper-management approval (2025-12-22, pending): https://fs.knesset.gov.il/25/law/25_ls1_10361883.pdf
- NBCTF: https://nbctf.mod.gov.il/en
- OpenSanctions NBCTF mirror: https://opensanctions.org/datasets/il_mod_terrorists
- FATF, revised Recommendation 8: https://www.fatf-gafi.org/en/publications/Fatfrecommendations/protecting-non-profits-abuse-implementation-R8.html
- FATF best practices on nonprofits: https://www.fatf-gafi.org/en/publications/Financialinclusionandnpoissues/Bpp-combating-abuse-npo.html
- Middesk TIN verification: https://docs.middesk.com/verify-business/tin
- Persona nonprofit report: https://help.withpersona.com/articles/6NMGFLlOatKM2lA7RNXjta/
- Candid Charity Check API: https://developer.candid.org/docs/charity-check-1
- Sumsub business verification sources: https://docs.sumsub.com/docs/business-verification-sources

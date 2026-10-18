# RUN-07 Data incident
Owner: security lead, with the on-call engineer and counsel · Severity: SEV1 · Last tested: never
Alert: a security alert from the SAST or secret-scanning jobs, a secret seen in a log or a repository, a certificate-expiry alert (within 14 days) that was missed, or a report from a provider or a member
Related: constitution art. 7 and 9; every flag; the secrets manager; `ops.audit`

## First five minutes
1. Rotate the affected secrets in the secrets manager; the app crashes on a missing secret rather than running without one, so rotate, then redeploy. Provider keys rotate on the provider's side too.
2. Isolate: revoke the compromised credential's sessions (token family revocation for a member token, the staff SSO session for an admin), and if the blast radius is unknown, flip the money flags to off through two admins.
3. Preserve logs: snapshot the log group and the database before anything is cleaned up. Do not delete anything.
4. Tell `#incidents` and the security lead; the security lead tells counsel within 24 hours.

## Resolution path
- Scope: which data classes (Tab 3 §6 PII classes), which members, which window. The audit chain (`verifyAdminAudit`) tells whether an admin action was involved.
- Notifications: counsel decides; the bank and regulators per the program agreement; Israeli members per the Privacy Protection Authority's notice rules; members with the counsel-approved template.
- A certificate within 14 days of expiry is this runbook before it expires: rotate it now, not at expiry.
- Money is not involved unless the incident shows a transfer the member did not make; that is RUN-04 or RUN-06.

## Member message
Template approved by counsel; nothing sent before counsel approves it. · Channel: email

## Verify it is over
- Every affected secret rotated and the old one proven dead (a request with it answers 401).
- Logs preserved and the timeline written; notifications sent and logged.
- Post-incident note within 2 business days; the control that failed named in the SOC 2 evidence folder.

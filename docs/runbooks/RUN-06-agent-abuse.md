# RUN-06 Agent abuse
Owner: on-call engineer, with the security lead · Severity: SEV2 (SEV1 if a money intent was approved under pressure) · Last tested: never
Alert: `mcp_rate_limit_storm` (rate-limit rejections over 100 per minute for one client), `mcp_intent_reject_spike` (pending intents rejected over 20 per hour), or a member report of an unexpected approval prompt
Related: REQ-AGT-003, REQ-AGT-006, REQ-AGT-008, REQ-AGT-009; flags `mcp.enabled`, `mcp.write.enabled`, `mcp.money.propose`; the MCP gateway at `/mcp`

## First five minutes
1. Identify the client: the audit entries carry the client id and the grant id. One client misbehaving is a revoke; many clients is a flag.
2. Revoke the client's grants: `revokeAgentGrant` for each grant (members can do the same from the grants screen within 60 s, REQ-AGT-008). The next call answers 401.
3. If widespread, flip `mcp.write.enabled` off through the admin API (`proposeFlagFlip`, then a second admin's `approveFlagFlip`); read-only tools keep working. Flip `mcp.money.propose` off first if money intents are involved.
4. Tell `#incidents`; tell the bank contact only if a money intent was executed.

## Resolution path
- Block the client's metadata URL in the CIMD registration deny-list; registrations from it are refused with the SSRF guard's error (REQ-AGT-003).
- Review the audit: every tool call is one row with grant, scope and outcome; export the window for the security lead.
- A money intent that was approved under pressure is a transfer like any other: it reverses through the normal reversing journal with two-person approval. Agents never move money on their own (REQ-AGT-006), so the approval is the member's; treat it as a social-engineering report.
- Re-enable `mcp.write.enabled` after 24 hours clean, two admins.

## Member message
Email affected users listing the grants revoked: "We removed the access you had given to {client name} on {date} after unusual activity. Nothing was changed on your account. You can grant access again from Settings." · Channel: email

## Verify it is over
- Rate-limit rejections and intent rejections back to baseline for one hour.
- The offending client has no live grants and its metadata URL is blocked.
- Post-incident note within 2 business days.

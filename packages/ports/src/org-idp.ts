// OrgIdPPort (REQ-AUTH-008): institution staff SSO (SAML/OIDC) and SCIM deprovisioning within 15 minutes.
// Vendor per ADR-004 (WorkOS or Clerk). Simulator models one connection per institution.

export interface OrgSsoStart {
  url: string;
  state: string;
}

export interface OrgIdentity {
  orgId: string;
  /** IdP subject; staff accounts key on (orgId, subject). */
  subject: string;
  email: string;
  displayName: string;
  groups: readonly string[];
}

export type ScimOp = 'create' | 'update' | 'deactivate';

export interface ScimEvent {
  orgId: string;
  op: ScimOp;
  subject: string;
  email: string;
  active: boolean;
  /** When the IdP emitted it; deprovisioning must land within 15 minutes of this (REQ-AUTH-008). */
  occurredAt: string;
  eventId: string;
}

/** One directory entry (REQ-AUTH-008). `rawState` is the vendor's own state string, untouched: anything but `active` / `inactive` is suspect. */
export interface DirectoryUser {
  subject: string;
  email: string;
  active: boolean;
  /** The raw state the directory reported, or undefined when it reported none. A reader must not treat a missing or unrecognised value as inactive. */
  rawState?: string | undefined;
}

export interface OrgIdPPort {
  startSso(orgId: string, input: { state: string; redirectUri: string }): Promise<OrgSsoStart>;
  handleCallback(input: { code: string; state: string }): Promise<OrgIdentity>;
  /** Verifies the SCIM bearer for the org and parses one event. Duplicate eventIds return the same result. */
  parseScimEvent(orgId: string, bearer: string, body: unknown): Promise<ScimEvent>;
  /** Directory snapshot for drift checks (nightly compare against local staff table). */
  listDirectory(orgId: string): Promise<readonly DirectoryUser[]>;
}

/**
 * Webhook signature header, shared by the WorkOS adapter and the inbound verifier (T-1116). Format per the WorkOS Directory Sync webhook docs
 * (relayed by the owner; verify against a real staging delivery before `auth.orgSso` is turned on): `WorkOS-Signature: t=<ms since the Unix
 * epoch>, v1=<hex>`, where `v1` is the hex HMAC-SHA256 of `${t}.${raw utf8 body}` keyed by the webhook secret. The timestamp is in
 * MILLISECONDS: a header whose `t` is in seconds is a date in 1970 and is refused as stale, never widened to accept both.
 */
export const WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export interface ParsedWebhookSignature {
  /** The `t` exactly as sent: the signed string uses this text, not a re-formatted number. */
  t: string;
  /** `t` as milliseconds since the Unix epoch. */
  tMs: number;
  /** Every well-formed `v1` value, lower-cased (WorkOS may send several while a secret rotates). */
  v1: string[];
}

/** Strict parse: comma-separated `key=value` parts (whitespace around parts is fine), exactly one numeric `t`, at least one 64-hex `v1`. Anything else is undefined. */
export function parseWebhookSignature(header: unknown): ParsedWebhookSignature | undefined {
  if (typeof header !== 'string' || header.length === 0 || header.length > 2048) return undefined;
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const p = part.trim();
    const eq = p.indexOf('=');
    if (eq <= 0) return undefined;
    const key = p.slice(0, eq);
    const value = p.slice(eq + 1);
    if (key === 't') {
      if (t !== undefined || !/^\d{1,16}$/.test(value)) return undefined;
      t = value;
    } else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) v1.push(value.toLowerCase());
  }
  if (t === undefined || v1.length === 0) return undefined;
  return { t, tMs: Number(t), v1 };
}

/** True when `t` (milliseconds) is within the tolerance of `nowMs` on either side: a stale and a future-dated header are both refused. */
export function webhookTimestampFresh(tMs: number, nowMs: number, toleranceMs: number = WEBHOOK_SIGNATURE_TOLERANCE_MS): boolean {
  return Math.abs(nowMs - tMs) <= toleranceMs;
}

export type OrgIdPErrorCode = 'UNKNOWN_ORG' | 'INVALID_CODE' | 'STATE_MISMATCH' | 'SCIM_UNAUTHORIZED' | 'SCIM_MALFORMED' | 'PROVIDER_UNAVAILABLE';

export class OrgIdPError extends Error {
  readonly code: OrgIdPErrorCode;
  constructor(
    code: OrgIdPErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'OrgIdPError';
  }
}

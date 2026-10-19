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

export interface OrgIdPPort {
  startSso(orgId: string, input: { state: string; redirectUri: string }): Promise<OrgSsoStart>;
  handleCallback(input: { code: string; state: string }): Promise<OrgIdentity>;
  /** Verifies the SCIM bearer for the org and parses one event. Duplicate eventIds return the same result. */
  parseScimEvent(orgId: string, bearer: string, body: unknown): Promise<ScimEvent>;
  /** Directory snapshot for drift checks (nightly compare against local staff table). */
  listDirectory(orgId: string): Promise<readonly { subject: string; email: string; active: boolean }[]>;
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

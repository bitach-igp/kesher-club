// AgentGateway (REQ-AGT-001..009): the inbound MCP surface. It is our own code (no vendor, no
// simulator); this file fixes the contract the API's /mcp module (T-1001..T-1006) must satisfy so the
// same suite runs against the in-process gateway in CI and against a deployed /mcp nightly.

export type ScopeTier = 'T0' | 'T1' | 'T2';

/** Scope tiers from REQ-AGT-005. */
export const SCOPES: Readonly<Record<string, ScopeTier>> = {
  'balances:read': 'T0',
  'transactions:read': 'T0',
  'card:status:read': 'T0',
  'esim:read': 'T0',
  'card:freeze': 'T1',
  'limits:propose': 'T1',
  'p2p:propose': 'T2',
  'load:propose': 'T2',
};

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly string[];
  bearer_methods_supported: readonly ['header'];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  /** Structured data only. Free text from merchants or users sits under `untrusted`. */
  data: Record<string, unknown>;
  untrusted?: Record<string, string>;
  /** For T2 tools: the pending intent a human must approve (REQ-AGT-006). */
  pendingIntentId?: string;
}

export type GatewayResponse =
  | { status: 200; body: ToolResult }
  | { status: 401; wwwAuthenticate: string; body: { error: 'invalid_token' | 'unauthorized'; error_description?: string } }
  | { status: 403; wwwAuthenticate: string; body: { error: 'insufficient_scope'; scope: string } }
  | { status: 404; body: { error: 'unknown_tool' } }
  | { status: 429; body: { error: 'rate_limited'; retryAfterSec: number } };

export interface AgentGateway {
  metadata(): ProtectedResourceMetadata;
  listTools(): readonly { name: string; tier: ScopeTier; scope: string }[];
  /** `authorization` is the raw header value or undefined. */
  call(authorization: string | undefined, call: ToolCall, context: { clientIp?: string; now: Date }): Promise<GatewayResponse>;
}

/** RFC 9728 challenge pointing at the resource metadata. */
export const challengeHeader = (resourceMetadataUrl: string, extra?: { error: string; scope?: string; description?: string }): string => {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
  if (extra) {
    parts.push(`error="${extra.error}"`);
    if (extra.scope) parts.push(`scope="${extra.scope}"`);
    if (extra.description) parts.push(`error_description="${extra.description}"`);
  }
  return parts.join(', ');
};

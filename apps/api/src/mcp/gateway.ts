// The /mcp gateway (T-1001..T-1004, REQ-AGT-001/002/005/007/009): metadata, 401 challenge,
// audience-bound token validation, scope tiers with insufficient_scope, 60 calls/min per grant,
// an audit row per call, and tools that wrap untrusted text. Satisfies agentGatewayContract.
import type { AgentGateway, GatewayResponse, ProtectedResourceMetadata, ToolCall } from '@kesher/ports';
import type { Database } from '../db.ts';
import { hasScope, type McpTokenValidator } from './auth.ts';
import { insufficientScopeChallenge, protectedResourceMetadata, unauthorizedChallenge, type McpConfig } from './metadata.ts';
import { listTools, toolByName, type ToolContext } from './tools/registry.ts';

export const RATE_LIMIT_PER_MINUTE = 60;

export class McpGateway implements AgentGateway {
  constructor(
    private readonly cfg: McpConfig,
    private readonly db: Database,
    private readonly validator: McpTokenValidator,
    private readonly ctx: (now: Date) => ToolContext,
  ) {}

  metadata(): ProtectedResourceMetadata {
    return protectedResourceMetadata(this.cfg);
  }

  listTools() {
    return listTools().map(({ name, tier, scope }) => ({ name, tier, scope }));
  }

  async call(authorization: string | undefined, call: ToolCall, context: { clientIp?: string; now: Date }): Promise<GatewayResponse> {
    const auth = await this.validator.validate(authorization, context.now);
    if (!auth.ok) return { status: 401, wwwAuthenticate: unauthorizedChallenge(this.cfg, auth.reason), body: { error: authorization ? 'invalid_token' : 'unauthorized', error_description: auth.reason } };
    const p = auth.principal;
    const tool = toolByName(call.name);
    const record = async (status: number) => {
      await this.db.query('insert into agent.call (grant_id, client_id, tool, status, at) values ($1, $2, $3, $4, $5)', [p.grantId, p.clientId, call.name, status, context.now]);
    };

    // 60/min per grant, counted on every authenticated call including refusals (REQ-AGT-009).
    const recent = await this.db.query<{ n: number }>('select count(*)::int as n from agent.call where grant_id = $1 and at > $2', [p.grantId, new Date(context.now.getTime() - 60_000)]);
    if ((recent.rows[0]?.n ?? 0) >= RATE_LIMIT_PER_MINUTE) {
      await record(429);
      return { status: 429, body: { error: 'rate_limited', retryAfterSec: 60 } };
    }
    if (!tool) {
      await record(404);
      return { status: 404, body: { error: 'unknown_tool' } };
    }
    if (!hasScope(p, tool.scope)) {
      await record(403);
      return { status: 403, wwwAuthenticate: insufficientScopeChallenge(this.cfg, tool.scope), body: { error: 'insufficient_scope', scope: tool.scope } };
    }
    try {
      const result = await tool.run(p, call.arguments, this.ctx(context.now));
      await record(200);
      return { status: 200, body: result };
    } catch (e) {
      const code = (e as { code?: string }).code;
      await record(code === 'AGENT_NOT_ALLOWED' ? 403 : 500);
      if (code === 'AGENT_NOT_ALLOWED') return { status: 403, wwwAuthenticate: insufficientScopeChallenge(this.cfg, tool.scope), body: { error: 'insufficient_scope', scope: tool.scope } };
      throw e;
    }
  }
}

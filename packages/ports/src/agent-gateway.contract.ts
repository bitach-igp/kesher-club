// AgentGateway contract (TST-AGT-001/002/005/007/009 at the gateway boundary). The API's /mcp module
// (T-1001..T-1006) runs this in CI; it also runs nightly against the deployed /mcp behind mcp.enabled.
import { describe, expect, it } from 'vitest';
import type { AgentGateway } from './agent-gateway.ts';

export interface AgentGatewayContractOptions {
  /** Mints a token for the gateway's audience with the given scopes (test AS). */
  tokenFor: (scopes: readonly string[], opts?: { audience?: string; grantId?: string }) => Promise<string>;
  resourceUrl: string;
  /** A T0 tool and the argument set that returns a merchant name. */
  readTool: { name: string; args: Record<string, unknown>; scope: string };
  /** A T1 tool and its scope. */
  writeTool: { name: string; args: Record<string, unknown>; scope: string };
  hostileMerchantName: string;
}

export function agentGatewayContract(name: string, make: () => AgentGateway, opts: AgentGatewayContractOptions): void {
  describe(`AgentGateway contract: ${name}`, () => {
    const now = new Date('2026-11-01T09:00:00Z');

    it('publishes protected resource metadata (REQ-AGT-001)', () => {
      const m = make().metadata();
      expect(m.resource).toBe(opts.resourceUrl);
      expect(m.authorization_servers.length).toBeGreaterThan(0);
      expect(m.bearer_methods_supported).toEqual(['header']);
      expect(m.scopes_supported).toContain(opts.readTool.scope);
    });

    it('an unauthenticated call gets 401 with WWW-Authenticate pointing at the metadata (REQ-AGT-001)', async () => {
      const r = await make().call(undefined, { name: opts.readTool.name, arguments: opts.readTool.args }, { now });
      expect(r.status).toBe(401);
      if (r.status === 401) expect(r.wwwAuthenticate).toMatch(/resource_metadata="https:\/\/.*oauth-protected-resource/);
    });

    it('rejects a token minted for another audience (REQ-AGT-002)', async () => {
      const token = await opts.tokenFor([opts.readTool.scope], { audience: 'https://api.kesher.example' });
      const r = await make().call(`Bearer ${token}`, { name: opts.readTool.name, arguments: opts.readTool.args }, { now });
      expect(r.status).toBe(401);
    });

    it('a T0 token calling a T1 tool gets 403 insufficient_scope naming the scope (REQ-AGT-005)', async () => {
      const token = await opts.tokenFor([opts.readTool.scope]);
      const r = await make().call(`Bearer ${token}`, { name: opts.writeTool.name, arguments: opts.writeTool.args }, { now });
      expect(r.status).toBe(403);
      if (r.status === 403) {
        expect(r.body.scope).toBe(opts.writeTool.scope);
        expect(r.wwwAuthenticate).toContain('insufficient_scope');
      }
    });

    it('wraps merchant text as untrusted data and never in the structured result (REQ-AGT-007)', async () => {
      const token = await opts.tokenFor([opts.readTool.scope]);
      const r = await make().call(`Bearer ${token}`, { name: opts.readTool.name, arguments: opts.readTool.args }, { now });
      expect(r.status).toBe(200);
      if (r.status === 200) {
        expect(JSON.stringify(r.body.untrusted ?? {})).toContain(opts.hostileMerchantName);
        expect(JSON.stringify(r.body.data)).not.toContain(opts.hostileMerchantName);
      }
    });

    it('rate-limits at 60 calls per minute per grant (REQ-AGT-009)', async () => {
      const gw = make();
      const token = await opts.tokenFor([opts.readTool.scope], { grantId: 'grant_rl' });
      let last;
      for (let i = 0; i < 61; i++) last = await gw.call(`Bearer ${token}`, { name: opts.readTool.name, arguments: opts.readTool.args }, { now: new Date(now.getTime() + i * 500) });
      expect(last!.status).toBe(429);
    });

    it('unknown tools are 404', async () => {
      const token = await opts.tokenFor([opts.readTool.scope]);
      expect((await make().call(`Bearer ${token}`, { name: 'no_such_tool', arguments: {} }, { now })).status).toBe(404);
    });
  });
}

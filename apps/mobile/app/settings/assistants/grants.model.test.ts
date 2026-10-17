// TST-AGT-008 (REQ-AGT-008): every grant shows client name, scopes and last use; one-tap revoke.
// TST-AGT-009 (REQ-AGT-009): a 429 from the gateway is explained as the 60/min per-grant limit.
import { describe, expect, it } from 'vitest';
import type { AgentGrant, GrantsApi } from '../../../src/api.ts';
import { createGrantsModel, relativeTime, scopeCopy } from './grants.model.ts';

const grants: AgentGrant[] = [
  { id: 'g1', clientId: 'https://assistant.example/client.json', clientName: 'Trip Planner', scopes: ['balances:read', 'esim:read', 'mystery:scope'], createdAt: '2026-10-01T09:00:00Z', lastUsedAt: '2026-11-01T08:30:00Z' },
  { id: 'g2', clientId: 'https://other.example/c', clientName: 'Budget Bot', scopes: ['p2p:propose'], createdAt: '2026-10-20T09:00:00Z' },
];

function fakeGrants(opts: { revokeFails?: 'rate' | 'other' } = {}) {
  const revoked: string[] = [];
  const api: GrantsApi = {
    listAgentGrants: async () => ({ items: grants.filter((g) => !revoked.includes(g.id)) }),
    async revokeAgentGrant(id) {
      if (opts.revokeFails === 'rate') throw Object.assign(new Error('429'), { code: 'RATE_LIMITED', status: 429 });
      if (opts.revokeFails === 'other') throw new Error('boom');
      revoked.push(id);
    },
  };
  return { api, revoked };
}

const now = new Date('2026-11-01T09:00:00Z');

describe('T-1006 grants screen (TST-AGT-008)', () => {
  it('lists client name, scopes (with copy per scope) and last used, never used for untouched grants', async () => {
    const m = createGrantsModel({ grants: fakeGrants().api });
    await m.load();
    const [g1, g2] = m.store.get().grants;
    expect(g1).toMatchObject({ clientName: 'Trip Planner', scopes: ['balances:read', 'esim:read', 'mystery:scope'] });
    expect(relativeTime(g1?.lastUsedAt, now)).toEqual({ key: 'time.minutesAgo', vars: { n: 30 } });
    expect(relativeTime(g2?.lastUsedAt, now)).toEqual({ key: 'grants.neverUsed', vars: {} });
    expect(relativeTime('2026-10-30T09:00:00Z', now)).toEqual({ key: 'time.daysAgo', vars: { n: 2 } });
    expect(scopeCopy('balances:read')).toEqual({ key: 'grants.scope.balances:read', vars: {} });
    // Unknown scope text is data: it goes into a placeholder, never into a copy key.
    expect(scopeCopy('mystery:scope')).toEqual({ key: 'grants.scope.unknown', vars: { scope: 'mystery:scope' } });
  });

  it('revokes in one tap and removes the row, with the 60 s notice', async () => {
    const { api, revoked } = fakeGrants();
    const m = createGrantsModel({ grants: api });
    await m.load();
    await m.revoke('g1');
    expect(revoked).toEqual(['g1']);
    expect(m.store.get().grants.map((g) => g.id)).toEqual(['g2']);
    expect(m.store.get().notice).toBe('grants.revoked');
    await m.load();
    expect(m.store.get().grants.map((g) => g.id)).toEqual(['g2']);
  });

  it('a failed revoke keeps the grant and says so', async () => {
    const m = createGrantsModel({ grants: fakeGrants({ revokeFails: 'other' }).api });
    await m.load();
    await m.revoke('g2');
    expect(m.store.get().grants.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(m.store.get()).toMatchObject({ error: 'grants.revokeFailed', grants: [expect.anything(), expect.objectContaining({ revoking: false })] });
  });
});

describe('T-1006 rate limits (TST-AGT-009)', () => {
  it('a 429 is explained as the per-grant 60/min limit', async () => {
    const m = createGrantsModel({ grants: fakeGrants({ revokeFails: 'rate' }).api });
    await m.load();
    await m.revoke('g1');
    expect(m.store.get().error).toBe('grants.rateLimited');
    expect(m.store.get().grants).toHaveLength(2);
  });
});

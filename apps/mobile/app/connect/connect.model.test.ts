// T-1017 "Connect an assistant" (TST-AGT-010, screen rows): the scopes read as words grouped by tier; the
// propose tier starts unticked; unticking keeps the rest; Connect sends only what was kept and opens the redirect
// the API answers; a stale step-up says so and the retry goes through; Not now opens access_denied; an expired
// request shows as gone.
import { describe, expect, it } from 'vitest';
import { ApiError } from '@kesher/sdk';
import type { AgentApi, AgentConsent } from '../../src/api.ts';
import { t } from '../../src/i18n.ts';
import { createConnectModel, groups, SCOPE_WORDS } from './connect.model.ts';

const REQ: AgentConsent = {
  id: 'req-1',
  client: { id: 'https://assistant.example/client.json', name: 'Trip Planner', uri: 'https://assistant.example' },
  scopes: [
    { scope: 'balances:read', tier: 'T0' },
    { scope: 'transactions:read', tier: 'T0' },
    { scope: 'card:freeze', tier: 'T1' },
    { scope: 'p2p:propose', tier: 'T2' },
  ],
  expiresAt: '2026-11-10T09:10:00Z',
};
const problem = (status: number, code: string) => new ApiError(status, { type: 'about:blank', title: code, status, code } as never);

function fake(over: Partial<{ consent: unknown; approve: unknown[] }> = {}) {
  const calls: { approve: string[][]; deny: number } = { approve: [], deny: 0 };
  const approveAnswers = [...(over.approve ?? [])];
  const agent: AgentApi = {
    async consent() {
      if (over.consent) throw over.consent;
      return REQ;
    },
    async approveConsent(_id, scopes) {
      calls.approve.push([...scopes]);
      const next = approveAnswers.shift();
      if (next) throw next;
      return { redirect: 'https://assistant.example/cb?code=abc&state=s&iss=https%3A%2F%2Fapi.kesher.example' };
    },
    async denyConsent() {
      calls.deny += 1;
      return { redirect: 'https://assistant.example/cb?error=access_denied&state=s' };
    },
  };
  const opened: string[] = [];
  return { agent, calls, opened, open: (u: string) => void opened.push(u) };
}

describe('Connect an assistant (T-1017)', () => {
  it('reads every scope as words, grouped read, act, propose', () => {
    expect(groups(REQ).map((g) => [g.tier, g.scopes])).toEqual([['T0', ['balances:read', 'transactions:read']], ['T1', ['card:freeze']], ['T2', ['p2p:propose']]]);
    for (const s of REQ.scopes) expect(t(SCOPE_WORDS[s.scope]!, 'en')).not.toContain(':');
    expect(t(SCOPE_WORDS['p2p:propose']!, 'he')).toBe('להציע תשלומים לאנשים');
  });

  it('starts with the propose tier unticked; unticking keeps the rest; Connect sends only what was kept and opens the redirect', async () => {
    const f = fake();
    const m = createConnectModel({ agent: f.agent, id: 'req-1', open: f.open });
    await m.load();
    expect(m.store.get().kept).toEqual(['balances:read', 'transactions:read', 'card:freeze']);
    m.toggle('card:freeze');
    m.toggle('nonsense:scope');
    await m.connect();
    expect(f.calls.approve).toEqual([['balances:read', 'transactions:read']]);
    expect(f.opened).toEqual(['https://assistant.example/cb?code=abc&state=s&iss=https%3A%2F%2Fapi.kesher.example']);
  });

  it('keeps one at least; a stale step-up says so and the retry goes through', async () => {
    const f = fake({ approve: [problem(401, 'STEP_UP_REQUIRED')] });
    const m = createConnectModel({ agent: f.agent, id: 'req-1', open: f.open });
    await m.load();
    for (const s of ['balances:read', 'transactions:read', 'card:freeze']) m.toggle(s);
    await m.connect();
    expect([m.store.get().error, f.calls.approve]).toEqual(['connect.keepOne', []]);
    m.toggle('balances:read');
    await m.connect();
    expect(m.store.get().needsStepUp).toBe(true);
    await m.connect();
    expect(f.calls.approve).toEqual([['balances:read'], ['balances:read']]);
    expect(f.opened).toHaveLength(1);
  });

  it('Not now opens access_denied; an expired or decided request shows as gone', async () => {
    const f = fake();
    const m = createConnectModel({ agent: f.agent, id: 'req-1', open: f.open });
    await m.load();
    await m.decline();
    expect(f.opened[0]).toContain('error=access_denied');
    const gone = createConnectModel({ agent: fake({ consent: problem(409, 'IDEMPOTENCY_CONFLICT') }).agent, id: 'req-1', open: () => undefined });
    await gone.load();
    expect(gone.store.get().mode).toBe('gone');
  });
});

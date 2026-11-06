// T-0053: a JIT decision emits one metrics line with its duration, and a failing emitter never changes the decision.
import { createMetrics, money, type Metrics } from '@kesher/domain';
import { type CardIssuingPort, type CardIssuingSimulator, type JitAuthorizationRequest } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db.ts';
import { JitService, type JitDeps } from './jit.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const REQ: JitAuthorizationRequest = { authId: 'auth-0001', cardId: 'card_unknown', amount: money(1_000n, 'ILS'), merchant: { name: 'Shop', mcc: '5912', country: 'IL' }, channel: 'pos', receivedAt: NOW.toISOString() };
const EMPTY = { rows: [{ prior_journal: null, id: null }], rowCount: 1 };

const service = (metrics: Metrics, db: { query: unknown }, extra: Partial<JitDeps> = {}) => new JitService({ db: db as unknown as Database, port: {} as CardIssuingPort, metrics, budgetMs: 50, ...extra } as JitDeps);
const known = { query: async () => EMPTY };

describe('JIT metrics (T-0053)', () => {
  it('emits one line per decision with its duration and no error', async () => {
    const lines: string[] = [];
    const out = await service(createMetrics({ write: (l) => lines.push(l) }), known).decide(REQ, NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'UNKNOWN_CARD' });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, number>;
    expect(line['jit.decision_ms']).toBeGreaterThanOrEqual(0);
    expect(line['jit.decision_ms']).toBeCloseTo(out.elapsedMs, 0);
    expect(line['jit.error']).toBe(0);
    expect(lines[0]).not.toMatch(/auth-0001|card_unknown/); // no identifier leaves the authorisation path
  });

  it('counts a decision that failed closed as an error, with no provider error (the port is not called inside decide)', async () => {
    const lines: string[] = [];
    const db = { query: async () => { throw new Error('db down'); } };
    const out = await service(createMetrics({ write: (l) => lines.push(l) }), db).decide(REQ, NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'TIMEOUT' });
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ 'jit.error': 1 });
  });

  it('emits provider.error{port} when the card-issuing port cannot read a request in handle(), but not for a forged signature', async () => {
    const lines: string[] = [];
    const host = new SimulatorHost();
    const port = host.registry.resolve<CardIssuingPort>('card-issuing', 'IL');
    const svc = service(createMetrics({ write: (l) => lines.push(l) }), known, { port });
    await expect(svc.handle({ 'x-sim-signature': 'sim' }, '{ not json', NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const emitted = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(emitted).toEqual([expect.objectContaining({ port: 'card-issuing', 'provider.error': 1 })]);
    lines.length = 0;
    const signed = (host.registry.resolve<CardIssuingPort>('card-issuing', 'IL') as CardIssuingSimulator).authorize('card_x', { amount: { minor: 100n, currency: 'ILS' }, merchant: { name: 'S', mcc: '5912', country: 'IL' }, channel: 'pos' });
    await expect(svc.handle({ ...signed.headers, 'x-sim-signature': 'forged' }, signed.rawBody, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(lines).toEqual([]);
  });

  it('counts a budget overrun as an error', async () => {
    const lines: string[] = [];
    const db = { query: () => new Promise(() => undefined) };
    const out = await service(createMetrics({ write: (l) => lines.push(l) }), db).decide(REQ, NOW);
    expect(out.decision).toEqual({ approve: false, reason: 'TIMEOUT' });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ 'jit.error': 1 });
  });

  it('a failing emitter does not alter the decision, on the answer path or the failure path', async () => {
    const broken = new Proxy({}, { get: () => () => { throw new Error('emitter down'); } }) as unknown as Metrics;
    const quiet = createMetrics({ write: () => undefined });
    const failing = { query: async () => { throw new Error('db down'); } };
    for (const db of [known, failing]) {
      const withBroken = await service(broken, db).decide(REQ, NOW);
      const withQuiet = await service(quiet, db).decide(REQ, NOW);
      expect(withBroken.decision).toEqual(withQuiet.decision);
    }
    const sinkThrows = createMetrics({ write: () => { throw new Error('stdout closed'); } });
    expect((await service(sinkThrows, known).decide(REQ, NOW)).decision).toEqual({ approve: false, reason: 'UNKNOWN_CARD' });
  });
});

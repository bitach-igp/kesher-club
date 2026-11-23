// T-0786 differential: seeded random sequences over one card load whose credit the vendor answers per a script (credited, pending,
// NOT_SUCCEEDED, a real refusal, an outage), with crashes (the outcome write, the flap-marker write, a lost answer), resolves of the credit
// case, a return and sweeps, run over an HONEST vendor (the first final answer per key is replayed, honest-credit-vendor.ts). The file runs
// unchanged on origin/main and on the T-0786 build: with `T0786_DIFF_OUT=path` it dumps one trace per sequence (vendor-call keys, answers, journals,
// transfer state, cases) so the two runs can be compared; the invariants below hold on the build and are the contract of the change.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { FundingSimulator, fixedClock, type AdvanceableClock, type FundingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { honestCreditVendor, type CreditScript } from './honest-credit-vendor.ts';
import { LoadService, settleKey } from './loads.ts';

const NOW = new Date('2026-11-02T09:00:00Z');
const LATER = new Date('2100-01-01T00:00:00Z');
const SEQUENCES = 120;
let db: TestDatabase;
let app: App;

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  app = createApp({ db, registry: host.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'funding.ach': true }) });
}, 60_000);
afterAll(async () => db.close());

type Op = 'sweep' | 'resolve' | 'return' | 'dieOutcome' | 'dieFlap' | 'loseAnswer';
interface Sequence { id: number; script: CreditScript[]; ops: Op[] }

/** mulberry32: a small seeded generator, so a failing sequence is reproduced by its id. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const sequences = (): Sequence[] => Array.from({ length: SEQUENCES }, (_, id) => {
  const r = rng(786_000 + id);
  const scripts: CreditScript[] = ['credited', 'pending', 'NOT_SUCCEEDED', 'NOT_SUCCEEDED', 'NOT_SUCCEEDED', 'ACCOUNT_UNAVAILABLE', 'outage'];
  const ops: Op[] = ['sweep', 'sweep', 'sweep', 'sweep', 'resolve', 'return', 'dieOutcome', 'dieFlap', 'loseAnswer'];
  return { id, script: Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, scripts)), ops: Array.from({ length: 2 + Math.floor(r() * 9) }, () => pick(r, ops)) };
});

interface Trace { id: number; script: string[]; ops: string[]; thrown: string[]; calls: string[]; answers: string[]; state: string; journals: number; credits: number; cases: { kind: string; status: string; reasonCode: unknown; attempt: unknown; stage: unknown }[] }

let nth = 0;
const run = async (q: Sequence): Promise<Trace> => {
  const s = app.services;
  nth += 1;
  const provider = `simulator-flap-${nth}`;
  const sim = new FundingSimulator(fixedClock(NOW.toISOString()), { credit: true });
  const party = uuidv7(NOW);
  await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_account', $1, $3, $2)`, [party, `a:${party}`, provider]);
  const vendor = honestCreditVendor(sim);
  vendor.script.push(...q.script);
  const ctl = { returned: false, dieOnOutcome: false, dieOnFlap: false };
  const port: FundingPort = { createLoad: (i, k) => sim.createLoad(i, k), getLoad: async (id) => { const l = await sim.getLoad(id); return ctl.returned ? { ...l, status: 'failed', failureCode: 'RETURNED' } : l; }, refund: (i, k) => sim.refund(i, k), getRefund: (id) => sim.getRefund(id), parseWebhook: (h, b) => sim.parseWebhook(h, b) };
  const flaky = new Proxy(db, { get: (target, prop) => (prop === 'query' ? (async (text: string, params?: readonly unknown[]) => {
    const kind = text.startsWith('insert into ops.workflow_marker') ? String(params?.[0]) : '';
    if (ctl.dieOnOutcome && kind === 'credit_outcome') { ctl.dieOnOutcome = false; throw new Error('outcome write failed'); }
    if (ctl.dieOnFlap && kind.startsWith('credit_flap')) { ctl.dieOnFlap = false; throw new Error('flap write failed'); }
    return (target.query as (t: string, p?: readonly unknown[]) => Promise<unknown>)(text, params);
  }) : Reflect.get(target, prop, target)) }) as typeof db;
  const svc = new LoadService({ db: flaky, port, credit: vendor, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
  const key = `flap-diff-${String(q.id).padStart(4, '0')}`;
  const thrown: string[] = [];
  const attempt = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { thrown.push(e instanceof Error ? e.message : String(e)); } };
  await attempt(() => svc.request(party, { memberPartyId: party, amount: { minor: '10000', currency: 'USD' }, method: 'card', paymentMethodId: 'pm_ok' }, key, NOW));
  const transfer = (await s.transfers.byKey(key))!;
  for (const op of q.ops) {
    if (op === 'sweep') await attempt(async () => { for (const x of await svc.stale(LATER, 0)) await svc.applyVendorLoad((await svc.vendorLoadOf(x.id))!, LATER); });
    else if (op === 'resolve') await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1 and status in ('open', 'investigating')`, [transfer.id]);
    else if (op === 'return') ctl.returned = true;
    else if (op === 'dieOutcome') ctl.dieOnOutcome = true;
    else if (op === 'dieFlap') ctl.dieOnFlap = true;
    else vendor.loseNextAnswer = true;
  }
  const cases = (await db.query<{ kind: string; status: string; payload: Record<string, unknown> }>(`select kind, status, payload from ops.case where payload->>'transferId' = $1 order by kind, dedupe_key`, [transfer.id])).rows;
  const journals = (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey(key)])).rows[0]!.n;
  return {
    id: q.id, script: q.script, ops: q.ops, thrown, calls: vendor.calls, answers: vendor.answers, state: (await s.transfers.byKey(key))!.state, journals, credits: sim.creditCount((await svc.vendorLoadOf(transfer.id))!),
    cases: cases.map((c) => ({ kind: c.kind, status: c.status, reasonCode: c.payload['reasonCode'], attempt: c.payload['attempt'], stage: c.payload['stage'] })),
  };
};

describe('seeded random sequences over an honest vendor (T-0786, TST-WAL-003)', () => {
  it(`${SEQUENCES} sequences: one journal at most, the vendor credits at most once, the case after NOT_SUCCEEDED appears only after the third case-less answer for a key and never twice`, async () => {
    const traces: Trace[] = [];
    for (const q of sequences()) traces.push(await run(q));
    if (process.env['T0786_DIFF_OUT']) writeFileSync(process.env['T0786_DIFF_OUT'], JSON.stringify(traces, null, 1));
    for (const t of traces) {
      const label = `sequence ${t.id}: ${t.script.join(',')} / ${t.ops.join(',')}`;
      expect(t.journals, label).toBeLessThanOrEqual(1);
      expect(t.credits, label).toBeLessThanOrEqual(1);
      if (t.journals === 1) expect(t.credits, label).toBe(1);
      const credit = t.cases.filter((c) => c.kind === 'load_credit_refused');
      expect(credit.length, label).toBeLessThanOrEqual(1);
      // Per key, the answers the vendor gave while no case was open: a NOT_SUCCEEDED case needs three of them for the key it names.
      for (const c of credit.filter((x) => x.reasonCode === 'NOT_SUCCEEDED')) {
        const suffix = `:credit:${String(c.attempt)}:refused:NOT_SUCCEEDED`;
        const n = t.answers.filter((a) => a.endsWith(suffix)).length;
        expect(n, label).toBeGreaterThanOrEqual(3);
      }
    }
  }, 120_000);
});

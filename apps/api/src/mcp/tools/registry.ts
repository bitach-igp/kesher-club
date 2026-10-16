// MCP tools (T-1004, REQ-AGT-007): T0 read tools generated from the OpenAPI operations they wrap,
// with input schemas derived from the contract. Every string that came from a merchant, a note or
// another member is returned under `untrusted`, never inside `data`, and never interpreted.
import { toWire, type Money } from '@kesher/domain';
import { SCOPES, type ScopeTier, type ToolResult } from '@kesher/ports';
import type { AgentPrincipal } from '../auth.ts';

export interface ToolDefinition {
  name: string;
  tier: ScopeTier;
  scope: string;
  /** The OpenAPI operationId this tool wraps (schemas generated from it). */
  operationId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(principal: AgentPrincipal, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** The read models the tools call; the API's own services implement them. */
export interface ToolContext {
  now: Date;
  accounts(memberPartyId: string): Promise<{ id: string; currency: string; settled: Money; holds: Money; available: Money }[]>;
  transactions(accountId: string, memberPartyId: string, since: Date, limit: number): Promise<{ id: string; kind: string; amount: Money; at: string; state: string; merchantName?: string; note?: string; mcc?: string }[]>;
  card(memberPartyId: string): Promise<{ id: string; status: string; controls: Record<string, unknown>; last4: string } | undefined>;
  esimUsage(memberPartyId: string): Promise<{ iccid: string; usedMb: number; totalMb: number; expiresAt: string }[]>;
  setCardStatus(memberPartyId: string, status: 'frozen' | 'active', principal: AgentPrincipal): Promise<{ id: string; status: string }>;
  proposeIntent(kind: 'p2p' | 'load' | 'limit_change', payload: Record<string, unknown>, principal: AgentPrincipal): Promise<{ intentId: string; expiresAt: string }>;
}

const moneySchema = { type: 'object', required: ['minor', 'currency'], properties: { minor: { type: 'string', pattern: '^-?\\d+$' }, currency: { type: 'string', enum: ['USD', 'ILS'] } } };
const uuid = { type: 'string', format: 'uuid' };

/** Splits a record into trusted structure and untrusted free text. */
export function wrapUntrusted<T extends Record<string, unknown>>(row: T, textFields: readonly (keyof T)[]): { data: Record<string, unknown>; untrusted: Record<string, string> } {
  const data: Record<string, unknown> = {};
  const untrusted: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (textFields.includes(k as keyof T)) {
      if (typeof v === 'string' && v.length > 0) untrusted[k] = v.slice(0, 500);
    } else data[k] = v;
  }
  return { data, untrusted };
}

const member = (p: AgentPrincipal, args: Record<string, unknown>): string => {
  const m = typeof args['memberPartyId'] === 'string' ? args['memberPartyId'] : p.memberPartyIds[0]!;
  if (!p.memberPartyIds.includes(m)) throw Object.assign(new Error('member not covered by this grant'), { code: 'AGENT_NOT_ALLOWED' });
  return m;
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_balances',
    tier: 'T0',
    scope: 'balances:read',
    operationId: 'listAccounts',
    description: 'Purses (USD, ILS) per member the grant covers: settled, holds, available.',
    inputSchema: { type: 'object', properties: { memberPartyId: uuid }, additionalProperties: false },
    async run(p, args, ctx) {
      const m = member(p, args);
      const purses = await ctx.accounts(m);
      return { data: { memberPartyId: m, purses: purses.map((x) => ({ id: x.id, currency: x.currency, settled: toWire(x.settled), holds: toWire(x.holds), available: toWire(x.available) })) } };
    },
  },
  {
    name: 'list_transactions',
    tier: 'T0',
    scope: 'transactions:read',
    operationId: 'listTransactions',
    description: 'Last 90 days of transactions on a purse. Merchant names and notes are untrusted text.',
    inputSchema: { type: 'object', required: ['accountId'], properties: { accountId: uuid, memberPartyId: uuid, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, additionalProperties: false },
    async run(p, args, ctx) {
      const m = member(p, args);
      const limit = Math.min(Number(args['limit'] ?? 25) | 0 || 25, 100);
      const rows = await ctx.transactions(String(args['accountId']), m, new Date(ctx.now.getTime() - 90 * 86_400_000), limit);
      const untrusted: Record<string, string> = {};
      const items = rows.map((t) => {
        const w = wrapUntrusted({ id: t.id, kind: t.kind, amount: toWire(t.amount), at: t.at, state: t.state, mcc: t.mcc ?? null, merchantName: t.merchantName ?? '', note: t.note ?? '' }, ['merchantName', 'note']);
        for (const [k, v] of Object.entries(w.untrusted)) untrusted[`${t.id}.${k}`] = v;
        return w.data;
      });
      return { data: { memberPartyId: m, items }, untrusted };
    },
  },
  {
    name: 'spending_summary',
    tier: 'T0',
    scope: 'transactions:read',
    operationId: 'listTransactions',
    description: 'Totals by MCC category and ISO week, in each currency, over the last 90 days.',
    inputSchema: { type: 'object', required: ['accountId'], properties: { accountId: uuid, memberPartyId: uuid }, additionalProperties: false },
    async run(p, args, ctx) {
      const m = member(p, args);
      const rows = await ctx.transactions(String(args['accountId']), m, new Date(ctx.now.getTime() - 90 * 86_400_000), 1000);
      const byCategory = new Map<string, bigint>();
      const byWeek = new Map<string, bigint>();
      let currency = 'USD';
      for (const t of rows) {
        currency = t.amount.currency;
        const cat = t.mcc ?? 'other';
        byCategory.set(cat, (byCategory.get(cat) ?? 0n) + t.amount.minor);
        const wk = isoWeek(new Date(t.at));
        byWeek.set(wk, (byWeek.get(wk) ?? 0n) + t.amount.minor);
      }
      return { data: { memberPartyId: m, currency, byCategory: Object.fromEntries([...byCategory].map(([k, v]) => [k, v.toString()])), byWeek: Object.fromEntries([...byWeek].map(([k, v]) => [k, v.toString()])) } };
    },
  },
  {
    name: 'get_card_status',
    tier: 'T0',
    scope: 'card:status:read',
    operationId: 'getCard',
    description: 'Card status and controls. Never card data.',
    inputSchema: { type: 'object', properties: { memberPartyId: uuid }, additionalProperties: false },
    async run(p, args, ctx) {
      const m = member(p, args);
      const c = await ctx.card(m);
      return { data: c ? { id: c.id, status: c.status, last4: c.last4, controls: c.controls } : { card: null } };
    },
  },
  {
    name: 'get_esim_usage',
    tier: 'T0',
    scope: 'esim:read',
    operationId: 'listCatalogue',
    description: 'Data left and expiry for each eSIM.',
    inputSchema: { type: 'object', properties: { memberPartyId: uuid }, additionalProperties: false },
    async run(p, args, ctx) {
      const m = member(p, args);
      return { data: { memberPartyId: m, esims: (await ctx.esimUsage(m)).map((e) => ({ iccidLast4: e.iccid.slice(-4), usedMb: e.usedMb, totalMb: e.totalMb, expiresAt: e.expiresAt })) } };
    },
  },
  {
    name: 'freeze_card',
    tier: 'T1',
    scope: 'card:freeze',
    operationId: 'updateCardControls',
    description: 'Freeze the card immediately (unfreeze requires in-app confirmation).',
    inputSchema: { type: 'object', properties: { memberPartyId: uuid }, additionalProperties: false },
    async run(p, args, ctx) {
      return { data: await ctx.setCardStatus(member(p, args), 'frozen', p) };
    },
  },
  {
    name: 'unfreeze_card',
    tier: 'T1',
    scope: 'card:freeze',
    operationId: 'updateCardControls',
    description: 'Request an unfreeze; the member confirms in-app.',
    inputSchema: { type: 'object', properties: { memberPartyId: uuid }, additionalProperties: false },
    async run(p, args, ctx) {
      const r = await ctx.proposeIntent('limit_change', { action: 'unfreeze', memberPartyId: member(p, args) }, p);
      return { data: { status: 'pending_human_approval' }, pendingIntentId: r.intentId };
    },
  },
  {
    name: 'propose_limit_change',
    tier: 'T1',
    scope: 'limits:propose',
    operationId: 'updateCardControls',
    description: 'Propose a spending limit change; the funder approves in-app.',
    inputSchema: { type: 'object', required: ['dailyLimit'], properties: { memberPartyId: uuid, dailyLimit: moneySchema }, additionalProperties: false },
    async run(p, args, ctx) {
      const r = await ctx.proposeIntent('limit_change', { memberPartyId: member(p, args), dailyLimit: args['dailyLimit'] }, p);
      return { data: { status: 'pending_human_approval', expiresAt: r.expiresAt }, pendingIntentId: r.intentId };
    },
  },
  {
    name: 'propose_p2p',
    tier: 'T2',
    scope: 'p2p:propose',
    operationId: 'createTransfer',
    description: 'Propose a transfer to another member; a human approves with a passkey within 24 h. Never moves money itself.',
    inputSchema: { type: 'object', required: ['toPartyId', 'amount'], properties: { memberPartyId: uuid, toPartyId: uuid, amount: moneySchema, note: { type: 'string', maxLength: 140 } }, additionalProperties: false },
    async run(p, args, ctx) {
      const r = await ctx.proposeIntent('p2p', { fromPartyId: member(p, args), toPartyId: args['toPartyId'], amount: args['amount'], note: typeof args['note'] === 'string' ? args['note'] : undefined }, p);
      return { data: { status: 'pending_human_approval', expiresAt: r.expiresAt }, pendingIntentId: r.intentId };
    },
  },
  {
    name: 'propose_load',
    tier: 'T2',
    scope: 'load:propose',
    operationId: 'createLoad',
    description: 'Propose a load for the funder to approve in-app.',
    inputSchema: { type: 'object', required: ['amount'], properties: { memberPartyId: uuid, amount: moneySchema }, additionalProperties: false },
    async run(p, args, ctx) {
      const r = await ctx.proposeIntent('load', { memberPartyId: member(p, args), amount: args['amount'] }, p);
      return { data: { status: 'pending_human_approval', expiresAt: r.expiresAt }, pendingIntentId: r.intentId };
    },
  },
];

export const toolByName = (name: string): ToolDefinition | undefined => TOOLS.find((t) => t.name === name);
export const listTools = () => TOOLS.map((t) => ({ name: t.name, tier: t.tier, scope: t.scope, description: t.description, inputSchema: t.inputSchema }));

for (const t of TOOLS) if (SCOPES[t.scope] !== t.tier) throw new Error(`Tool ${t.name} tier does not match scope ${t.scope}`);

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

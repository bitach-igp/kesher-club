// GET /me/capabilities (T-0302): flags + entitlements in one payload; the app renders only what
// this returns. Flags come from a FeatureFlags provider (config/flags.json defaults now; the
// two-person-approved store from T-0905 later). Unknown flag → off (fail secure).
import fs from 'node:fs';
import path from 'node:path';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { EntitlementService } from './entitlements.ts';
import type { MembershipService } from './memberships.ts';

export interface FeatureFlags {
  isOn(key: string, context?: { partyId?: string }): boolean | Promise<boolean>;
  keys(): readonly string[];
}

interface FlagRow {
  key: string;
  defaultProd: boolean;
  owner: string;
  gates: string;
}

/** The registry defaults from config/flags.json. Non-prod environments may turn more on via `overrides`. */
export class StaticFlags implements FeatureFlags {
  private readonly values: Map<string, boolean>;
  constructor(rows: readonly FlagRow[] = loadRegistry(), overrides: Record<string, boolean> = {}) {
    this.values = new Map(rows.map((r) => [r.key, overrides[r.key] ?? r.defaultProd]));
    for (const k of Object.keys(overrides)) if (!this.values.has(k)) throw new Error(`Unknown flag ${k}: flags live only in config/flags.json (constitution art. 8)`);
  }
  isOn(key: string): boolean {
    return this.values.get(key) ?? false;
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

export function loadRegistry(file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../config/flags.json')): FlagRow[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as FlagRow[];
}

/** Flags the client is allowed to see (everything that gates a screen or a button). */
const CLIENT_VISIBLE = /^(auth\.|billing\.|esim\.|insurance\.|concierge\.|wallet\.|card\.|p2p\.|fx\.|payouts\.|institutions\.|funding\.|mcp\.|notify\.|ui\.)/;

export function capabilitiesHandler(deps: { flags: FeatureFlags; memberships: MembershipService; entitlements: EntitlementService }): Handler {
  return route(async (req) => {
    const principal = requirePrincipal(req);
    const features: Record<string, boolean> = {};
    for (const key of deps.flags.keys()) if (CLIENT_VISIBLE.test(key)) features[key] = await deps.flags.isOn(key, { partyId: principal.partyId });
    const membership = await deps.memberships.forMember(principal.partyId);
    const entitlements = membership ? await deps.entitlements.summary(membership, req.now) : {};
    return ok({ features, entitlements, membership: membership ? { status: membership.status, planCode: membership.planCode } : null });
  });
}

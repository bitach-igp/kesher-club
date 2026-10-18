// GET /status (T-0911, CLUB-39): the public state of each money capability, for the in-app banner and a
// later status page. No bearer, no secrets, no provider names: a capability is `off` when its flag is
// off, `degraded` when an admin switched it off with an incident (the kill switch, RUN-01), and `ok` when
// its flag is on and its provider is bound for the market. The incident text is member-facing copy an
// admin wrote on the two-person flag flip; it is shown as text, never as a link.
import type { Market, ProviderRegistry } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Incident } from '../flags/service.ts';
import { ok, route, type Handler } from '../http.ts';

export type CapabilityState = 'ok' | 'degraded' | 'off';

/** The money capabilities a member can see, the flag that switches each and the port it runs on. */
export const STATUS_CAPABILITIES = [
  { name: 'wallet', flag: 'wallet.enabled', port: 'funding' },
  { name: 'card', flag: 'card.virtual', port: 'card-issuing' },
  { name: 'p2p', flag: 'p2p.enabled' },
  { name: 'fx', flag: 'fx.enabled', port: 'fx' },
  { name: 'payouts', flag: 'payouts.nium', port: 'payout' },
] as const;

export type CapabilityName = (typeof STATUS_CAPABILITIES)[number]['name'];

export interface ServiceStatus {
  capabilities: Record<CapabilityName, CapabilityState>;
  incident?: { title: string; body: string; since: string };
}

interface Deps {
  /** The flag store; when it can name incidents (FlagService), degraded states and the banner come from it. */
  flags: FeatureFlags & { incidents?: () => Promise<Incident[]> };
  registry: Pick<ProviderRegistry, 'bindingFor'>;
  market: Market;
}

export async function serviceStatus(d: Deps): Promise<ServiceStatus> {
  const incidents = new Map((d.flags.incidents ? await d.flags.incidents() : []).map((i) => [i.key, i]));
  const capabilities = {} as Record<CapabilityName, CapabilityState>;
  let latest: Incident | undefined;
  for (const c of STATUS_CAPABILITIES) {
    const incident = incidents.get(c.flag);
    if (await d.flags.isOn(c.flag)) {
      capabilities[c.name] = 'port' in c && !d.registry.bindingFor(c.port, d.market) ? 'off' : 'ok';
    } else if (incident) {
      capabilities[c.name] = 'degraded';
      if (!latest || incident.since > latest.since) latest = incident;
    } else {
      capabilities[c.name] = 'off';
    }
  }
  return { capabilities, ...(latest ? { incident: { title: latest.title, body: latest.body, since: latest.since } } : {}) };
}

export function statusHandler(d: Deps): Handler {
  return route(async () => ok(await serviceStatus(d)));
}

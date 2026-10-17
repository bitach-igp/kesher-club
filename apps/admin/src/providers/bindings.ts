// Providers table rows (A07): every port with its current binding, switch-on readiness and kill
// switch state, built from the port catalogue plus the stored bindings and flags.
import { PORTS, type PortDescriptor } from '@kesher/ports';
import type { FlagState, ProviderBinding } from '../data/types.ts';
import { evaluateFlip, gatesFor } from './release-gates.ts';

export interface ProviderRow {
  capability: string;
  port: string;
  direction: PortDescriptor['direction'];
  binding: string;
  vendors: readonly string[];
  degraded: boolean;
  contractGreenNights: number;
  flags: { key: string; on: boolean; gatesTicked: number; gatesTotal: number; pending: boolean }[];
  /** "ready" when at least one flag could go live now; "simulator" when nothing is bound yet. */
  status: 'live' | 'degraded' | 'ready' | 'simulator' | 'blocked';
}

export function providerRows(bindings: readonly ProviderBinding[], flags: readonly FlagState[]): ProviderRow[] {
  const byKey = new Map(flags.map((f) => [f.key, f]));
  return PORTS.map((p) => {
    const b = bindings.find((x) => x.capability === p.capability);
    const rows = p.flags.map((key) => {
      const f = byKey.get(key);
      const total = gatesFor(key).length;
      return { key, on: f?.on ?? false, gatesTicked: f ? f.gatesTicked.filter((g) => gatesFor(key).some((x) => x.id === g)).length : 0, gatesTotal: total, pending: f?.pendingFlip !== undefined };
    });
    const anyOn = rows.some((r) => r.on);
    const anyReady = rows.some((r) => !r.on && evaluateFlip(r.key, byKey.get(r.key)?.gatesTicked ?? [], []).gatesComplete);
    const status: ProviderRow['status'] = b?.degraded ? 'degraded' : anyOn ? 'live' : !b || b.binding === 'simulator' ? (anyReady ? 'ready' : 'simulator') : anyReady ? 'ready' : 'blocked';
    return { capability: p.capability, port: p.port, direction: p.direction, binding: b?.binding ?? 'simulator', vendors: p.vendors, degraded: b?.degraded ?? false, contractGreenNights: b?.contractGreenNights ?? 0, flags: rows, status };
  });
}

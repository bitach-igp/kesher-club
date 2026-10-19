// The provider registry a process runs on (T-0021). `sim` binds every port to the in-process
// simulators (previews and staging until ADR-006 names a processor); the config refuses any other
// mode until a vendor adapter exists, so there is no branch here for one yet. Tests keep their own
// SimulatorHost on a fixed clock; a running process gets the wall clock, which the simulators'
// control panel may still nudge forward.
import type { AdvanceableClock, ProviderRegistry } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';

/** Wall-clock time plus whatever the simulators' control panel has advanced it by. */
export function systemClock(): AdvanceableClock {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

export function createRegistry(mode: string, clock: AdvanceableClock = systemClock()): { registry: ProviderRegistry; simulators: SimulatorHost } {
  // The config already refuses anything but `sim` (T-0020); this guards a caller that skipped it.
  if (mode !== 'sim') throw new Error(`No vendor adapters are wired for provider mode "${mode}" yet (ADR-006)`);
  const simulators = new SimulatorHost(clock);
  return { registry: simulators.registry, simulators };
}

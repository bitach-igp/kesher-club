import { type AdvanceableClock } from './base.ts';
import { eventsContract } from './events.contract.ts';
import { EventsSimulator } from './events.simulator.ts';

eventsContract('simulator', () => new EventsSimulator(), {
  goodUrl: 'https://console.yeshiva.example/hooks/kesher',
  failingUrl: 'https://console.yeshiva.example/hooks/fail',
  lastRequest: async (port) => (port as EventsSimulator).delivered.at(-1)!,
  runRetriesAfter: async (port, ms) => {
    const sim = port as EventsSimulator & { clock: AdvanceableClock };
    sim.clock.advance(ms);
    return sim.runRetries();
  },
});

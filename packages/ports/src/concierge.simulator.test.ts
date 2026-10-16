import { conciergeContract } from './concierge.contract.ts';
import { ConciergeSimulator } from './concierge.simulator.ts';

conciergeContract('simulator', () => new ConciergeSimulator(), { outageSummary: 'OUTAGE please' });

import { passContract } from './pass.contract.ts';
import { PassSimulator } from './pass.simulator.ts';

passContract('simulator', () => new PassSimulator(), { outageMemberId: 'm_outage' });

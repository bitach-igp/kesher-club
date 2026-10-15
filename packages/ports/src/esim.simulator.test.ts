import { esimContract } from './esim.contract.ts';
import { EsimSimulator } from './esim.simulator.ts';

esimContract('simulator', () => new EsimSimulator(), { failingSku: 'IL-FAIL' });

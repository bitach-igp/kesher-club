import { insuranceContract } from './insurance.contract.ts';
import { InsuranceSimulator } from './insurance.simulator.ts';

insuranceContract('simulator', () => new InsuranceSimulator(), { product: 'gadget', outageProduct: 'outage' });

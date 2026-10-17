import { ilPayInitContract } from './il-payinit.contract.ts';
import { IlPayInitSimulator } from './il-payinit.simulator.ts';

ilPayInitContract('simulator', () => new IlPayInitSimulator(), {
  callback: async (port, id) => (port as IlPayInitSimulator).bankCallback(id),
  rejectedReference: 'REJECT-1',
  outageBankCode: '000',
});

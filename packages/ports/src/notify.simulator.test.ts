import { notifyContract } from './notify.contract.ts';
import { NotifySimulator } from './notify.simulator.ts';

notifyContract('simulator', () => new NotifySimulator(), { channel: 'email', goodRecipient: 'noa@example.com', badRecipient: 'not-an-email', bouncingRecipient: 'bounce@example.com', outageRecipient: 'outage@example.com' });
notifyContract('simulator', () => new NotifySimulator(), { channel: 'sms', goodRecipient: '+972501234567', badRecipient: '0501234567', outageRecipient: '+15550000001' });
notifyContract('simulator', () => new NotifySimulator(), { channel: 'push', goodRecipient: 'ExponentPushToken[abc]', badRecipient: 'not-a-token' });

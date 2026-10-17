import { describe, expect, it } from 'vitest';
import type { ConciergeApi } from '../../src/api.ts';
import { fakeDevice } from '../../src/device.ts';
import { recordingOpener } from '../../src/linking.ts';
import type { SupportContacts } from '../../src/support.ts';
import { createEmergencyModel } from './emergency.model.ts';

const support: SupportContacts = { helpLine: '+97231234567', whatsapp: '+972501234567', emergency: '+97239999999', faqUrl: 'https://help.example' };

function fakeConcierge(fail = false) {
  const opened: { key: string; input: Parameters<ConciergeApi['openEmergencyCase']>[0] }[] = [];
  const api: ConciergeApi = {
    async openEmergencyCase(input, key) {
      if (fail) throw Object.assign(new Error('down'), { code: 'PROVIDER_UNAVAILABLE', status: 503 });
      if (!opened.some((o) => o.key === key)) opened.push({ key, input });
      return { caseId: 'case-1', callbackSlaMinutes: 5 };
    },
  };
  return { api, opened };
}

describe('M32 emergency', () => {
  it('one tap opens a case, then dials; a second tap dials again without a second case', async () => {
    const { api, opened } = fakeConcierge();
    const opener = recordingOpener();
    const m = createEmergencyModel({ concierge: api, device: fakeDevice(), opener, support, locale: 'he', newKey: () => 'k1' });
    await m.callForHelp();
    expect(opened).toEqual([{ key: 'k1', input: { locale: 'he', notifyFunder: false } }]);
    expect(m.store.get().opened).toEqual({ caseId: 'case-1', callbackSlaMinutes: 5 });
    expect(opener.opened).toEqual(['tel:+97239999999']);
    await m.callForHelp();
    expect(opened).toHaveLength(1);
    expect(opener.opened).toHaveLength(2);
  });

  it('shares location and tells the funder only when opted in', async () => {
    const { api, opened } = fakeConcierge();
    const m = createEmergencyModel({ concierge: api, device: fakeDevice(), opener: recordingOpener(), support, locale: 'en', newKey: () => 'k2' });
    m.setShareLocation(true);
    m.setNotifyFunder(true);
    m.setNote('  Fell near the Old City  ');
    await m.callForHelp();
    expect(opened[0]?.input).toEqual({ locale: 'en', notifyFunder: true, note: 'Fell near the Old City', location: { lat: 31.77, lng: 35.21, accuracyM: 12 } });
  });

  it('a denied location permission still opens the case and offers Settings', async () => {
    const { api, opened } = fakeConcierge();
    const opener = recordingOpener();
    const m = createEmergencyModel({ concierge: api, device: fakeDevice({}, { status: 'denied' }), opener, support, locale: 'en', newKey: () => 'k3' });
    m.setShareLocation(true);
    await m.callForHelp();
    expect(opened[0]?.input.location).toBeUndefined();
    expect(m.store.get()).toMatchObject({ locationDenied: true, opened: { caseId: 'case-1' } });
    await m.openSettings();
    expect(opener.settingsOpened).toBe(1);
  });

  it('when the case cannot be opened the call still goes out and the screen says so', async () => {
    const opener = recordingOpener();
    const m = createEmergencyModel({ concierge: fakeConcierge(true).api, device: fakeDevice(), opener, support, locale: 'en', newKey: () => 'k4' });
    await m.callForHelp();
    expect(m.store.get().error).toBe('emergency.failed');
    expect(m.store.get().opened).toBeUndefined();
    expect(opener.opened).toEqual(['tel:+97239999999']);
    await m.callNow();
    expect(opener.opened).toHaveLength(2);
  });
});

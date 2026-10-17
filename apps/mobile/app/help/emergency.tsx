// M32 Emergency: one button (call + share location + notify funder, both opt-in). Edge: no location permission.
import { useMemo } from 'react';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, Screen, TextField, Toggle, Txt } from '../../src/components/index.ts';
import { useDevice } from '../../src/device.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useOpener } from '../../src/linking.ts';
import { useStore } from '../../src/model.ts';
import { useSupport } from '../../src/support.ts';
import { createEmergencyModel, type EmergencyModel } from './emergency.model.ts';

export default function EmergencyScreen() {
  const api = useApi();
  const device = useDevice();
  const opener = useOpener();
  const support = useSupport();
  const locale = useLocale();
  const model = useMemo(() => createEmergencyModel({ concierge: api.concierge, device, opener, support, locale, newKey: uuidv7 }), [api, device, opener, support, locale]);
  return <EmergencyView model={model} />;
}

export function EmergencyView({ model }: { model: EmergencyModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const support = useSupport();
  return (
    <Screen
      title={t('emergency.title', locale)}
      subtitle={t('emergency.subtitle', locale, { sla: s.opened?.callbackSlaMinutes ?? 5 })}
      testID="screen-emergency"
      footer={
        <>
          <Button label={t(s.busy ? 'emergency.calling' : s.opened ? 'emergency.callAgain' : 'emergency.button', locale)} variant="destructive" onPress={() => void model.callForHelp()} loading={s.busy} testID="emergency-call" />
          {s.error ? <Button label={t('emergency.callAnyway', locale)} variant="secondary" onPress={() => void model.callNow()} testID="emergency-call-anyway" /> : null}
        </>
      }
    >
      {s.opened ? <Banner tone="success" body={t('emergency.opened', locale, { caseId: s.opened.caseId })} testID="emergency-opened" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="emergency-error" /> : null}
      {s.locationDenied ? <Banner tone="warning" body={t('emergency.location.denied', locale)} action={{ label: t('emergency.location.openSettings', locale), onPress: () => void model.openSettings() }} testID="emergency-location-denied" /> : null}
      <Card>
        <Toggle label={t('emergency.location.label', locale)} hint={t('emergency.location.hint', locale)} value={s.shareLocation} onChange={model.setShareLocation} testID="emergency-share-location" />
        <Toggle label={t('emergency.notify.label', locale)} hint={t('emergency.notify.hint', locale)} value={s.notifyFunder} onChange={model.setNotifyFunder} testID="emergency-notify-funder" />
      </Card>
      <TextField label={t('emergency.note.label', locale)} value={s.note} onChangeText={model.setNote} multiline testID="emergency-note" />
      <Txt variant="caption" tone="secondary">
        {t('emergency.notReady', locale, { phone: support.emergency })}
      </Txt>
    </Screen>
  );
}

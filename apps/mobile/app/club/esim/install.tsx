// M27 eSIM install: one tap (iOS 17.4+ / Android), QR for another device, manual activation code.
// Edge: install failed → help; still provisioning → preparing.
import { useState } from 'react';
import { Banner, Button, Card, QrCode, Screen, Skeleton, Txt } from '../../../src/components/index.ts';
import { t, useLocale } from '../../../src/i18n.ts';
import { useStore } from '../../../src/model.ts';
import { useEsimModel } from '../esim.tsx';
import type { EsimModel } from '../esim.model.ts';

export default function EsimInstallScreen() {
  return <EsimInstallView model={useEsimModel()} />;
}

export function EsimInstallView({ model }: { model: EsimModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const [help, setHelp] = useState(false);
  const i = s.install;
  return (
    <Screen
      title={t('install.title', locale)}
      testID="screen-esim-install"
      footer={
        i ? (
          <>
            {i.oneTap ? <Button label={t('install.oneTap', locale)} accessibilityHint={t('install.oneTap.hint', locale)} onPress={() => void model.installOneTap()} testID="install-one-tap" /> : null}
            <Button label={t('install.done', locale)} variant={i.oneTap ? 'secondary' : 'primary'} onPress={model.installed} testID="install-done" />
            <Button label={t('install.failed.link', locale)} variant="tertiary" onPress={() => setHelp(true)} testID="install-failed-link" />
          </>
        ) : undefined
      }
    >
      {!i ? (
        <>
          <Txt tone="secondary">{t('install.preparing', locale)}</Txt>
          <Skeleton />
        </>
      ) : (
        <>
          {help ? <Banner tone="info" title={t('install.failed.title', locale)} body={t('install.failed.body', locale)} action={{ label: t('install.failed.help', locale), onPress: model.installFailed }} testID="install-help" /> : null}
          {!i.oneTap ? <Banner tone="info" title={t('install.manual.title', locale)} body={t('install.manual.hint', locale)} /> : null}
          <Card>
            <Txt variant="headline">{t('install.qr.title', locale)}</Txt>
            <Txt tone="secondary">{t('install.qr.hint', locale)}</Txt>
            <QrCode payload={i.lpa} label={t('install.lpa.label', locale)} />
          </Card>
          <Card>
            <Txt variant="caption" tone="secondary">
              {t('install.lpa.label', locale)}
            </Txt>
            <Txt tabular selectable testID="install-lpa">
              {i.lpa}
            </Txt>
            <Button label={t(s.copied ? 'install.lpa.copied' : 'install.lpa.copy', locale)} variant="secondary" onPress={() => void model.copyActivationCode()} testID="install-copy" />
            <Txt variant="caption" tone="secondary">
              {t(i.steps, locale)}
            </Txt>
          </Card>
        </>
      )}
    </Screen>
  );
}

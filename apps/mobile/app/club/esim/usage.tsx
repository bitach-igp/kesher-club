// M28 eSIM usage: data meter, days left, top up. Edge: low data, expiring, expired.
import { useEffect } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Screen, Skeleton, Txt } from '../../../src/components/index.ts';
import { t, useLocale } from '../../../src/i18n.ts';
import { useStore } from '../../../src/model.ts';
import { useParams } from '../../../src/navigation.ts';
import { useTheme } from '../../../src/theme.ts';
import { useEsimModel } from '../esim.tsx';
import type { EsimModel } from '../esim.model.ts';

export default function EsimUsageScreen() {
  const params = useParams();
  return <EsimUsageView model={useEsimModel()} iccid={params['iccid'] ?? ''} />;
}

export function EsimUsageView({ model, iccid }: { model: EsimModel; iccid: string }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const th = useTheme();
  useEffect(() => void model.loadUsage(iccid), [model, iccid]);
  const u = s.usage;
  return (
    <Screen title={t('usage.title', locale)} testID="screen-esim-usage" footer={u ? <Button label={t(u.expired ? 'usage.buyNew' : 'usage.topUp', locale)} onPress={model.topUp} testID="usage-top-up" /> : undefined}>
      {s.status === 'loading' || !u ? <Skeleton /> : null}
      {s.error ? <Banner tone="warning" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.loadUsage(iccid) }} /> : null}
      {u?.expired ? <Banner tone="danger" title={t('usage.expired.title', locale)} body={t('usage.expired.body', locale)} testID="usage-expired" /> : null}
      {u?.low ? <Banner tone="warning" title={t('usage.low.title', locale)} body={t('usage.low.body', locale)} testID="usage-low" /> : null}
      {u?.expiring && !u.low ? <Banner tone="warning" title={t('usage.expiring.title', locale)} body={t('usage.expiring.body', locale, { days: u.daysLeft })} testID="usage-expiring" /> : null}
      {u ? (
        <Card testID="usage-meter">
          <Txt variant="title2" tabular>
            {t('usage.remaining', locale, { gb: u.remainingGb, total: u.totalGb })}
          </Txt>
          <View accessibilityRole="progressbar" accessibilityLabel={t('usage.meter', locale)} accessibilityValue={{ min: 0, max: 100, now: u.pctLeft }} style={{ height: 12, borderRadius: th.radius.full, backgroundColor: th.color.bg.sunken, overflow: 'hidden' }}>
            <View style={{ width: `${u.pctLeft}%`, height: '100%', backgroundColor: u.expired ? th.color.status.danger : u.low ? th.color.status.warning : th.color.action.primary }} />
          </View>
          <Txt tone="secondary">{u.expired ? t('usage.expired', locale) : u.daysLeft === 0 ? t('usage.expiresToday', locale) : t('usage.daysLeft', locale, { days: u.daysLeft })}</Txt>
        </Card>
      ) : null}
    </Screen>
  );
}

// M25 Club hub: plan entitlements left and the add-ons grid.
import { useEffect, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { useApi } from '../../src/api.ts';
import { Badge, Banner, Card, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale, type CopyKey } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { useTheme } from '../../src/theme.ts';
import { createHubModel, type HubModel } from './hub.model.ts';

export default function ClubHubScreen() {
  const api = useApi();
  const router = useRouter();
  const model = useMemo(() => createHubModel({ club: api.club, router }), [api, router]);
  return <ClubHubView model={model} />;
}

export function ClubHubView({ model }: { model: HubModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const th = useTheme();
  useEffect(() => void model.load(), [model]);
  return (
    <Screen title={t('hub.title', locale)} subtitle={t('hub.subtitle', locale)} testID="screen-club-hub">
      {s.status === 'loading' || s.status === 'idle' ? <Skeleton /> : null}
      {s.error ? <Banner tone="warning" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} /> : null}
      {s.status === 'ready' ? (
        <Card testID="hub-entitlements">
          <Txt variant="headline">{t('hub.entitlements', locale)}</Txt>
          {s.entitlements.length === 0 ? <Txt tone="secondary">{t('hub.empty', locale)}</Txt> : null}
          {s.entitlements.map((e, i) => (
            <ListRow key={e.key} title={e.key} {...(e.resetsAt ? { subtitle: t('hub.entitlement.resets', locale, { date: e.resetsAt.slice(0, 10) }) } : {})} trailing={t('hub.entitlement.left', locale, { n: e.remaining, unit: e.unit })} last={i === s.entitlements.length - 1} />
          ))}
        </Card>
      ) : null}
      {s.status === 'ready' ? (
        <View style={{ gap: th.space[3] }}>
          <Txt variant="headline">{t('hub.addons', locale)}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space[3] }}>
            {s.addons.map((a) => (
              <Pressable key={a.kind} accessibilityRole="button" accessibilityLabel={t(`hub.addon.${a.kind}` as CopyKey, locale)} accessibilityState={{ disabled: !a.on }} onPress={() => model.open(a.kind)} testID={`addon-${a.kind}`} style={{ flexBasis: '47%', flexGrow: 1 }}>
                <Card>
                  <Txt variant="headline">{t(`hub.addon.${a.kind}` as CopyKey, locale)}</Txt>
                  {a.on ? null : <Badge label={t('hub.addon.off', locale)} tone="neutral" />}
                </Card>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

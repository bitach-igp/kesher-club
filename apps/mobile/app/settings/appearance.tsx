// REQ-UX-003 (T-1021): System, Light or Dark; one tap saves and the whole app changes at once.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Card, ListRow, Screen, Skeleton } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { APPEARANCE_OPTIONS, createAppearanceModel, useSharedAppearance, type AppearanceModel } from './appearance.model.ts';

export default function AppearanceScreen() {
  const api = useApi();
  const shared = useSharedAppearance();
  const model = useMemo(() => createAppearanceModel({ preferences: api.preferences, shared }), [api, shared]);
  return <AppearanceView model={model} />;
}

export function AppearanceView({ model }: { model: AppearanceModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  return (
    <Screen title={t('appearance.title', locale)} subtitle={t('appearance.subtitle', locale)} testID="screen-appearance">
      {s.status === 'loading' || s.status === 'idle' ? <Skeleton /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="appearance-notice" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} testID="appearance-error" /> : null}
      {s.status === 'ready' ? (
        <Card>
          {APPEARANCE_OPTIONS.map((o, i) => (
            <ListRow
              key={o.value}
              title={t(o.label, locale)}
              {...(o.helper ? { subtitle: t(o.helper, locale) } : {})}
              {...(s.theme === o.value ? { trailing: '✓' } : {})}
              onPress={() => void model.choose(o.value)}
              accessibilityLabel={t(o.label, locale)}
              testID={`appearance-${o.value}`}
              last={i === APPEARANCE_OPTIONS.length - 1}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

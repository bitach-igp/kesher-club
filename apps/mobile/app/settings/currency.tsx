// M33 receiving currency (T-0516): as sent, shekels or dollars; one tap saves.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Card, ListRow, Screen, Skeleton } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { createCurrencyModel, RECEIVE_OPTIONS, type CurrencyModel } from './currency.model.ts';

export default function CurrencyScreen() {
  const api = useApi();
  const model = useMemo(() => createCurrencyModel({ preferences: api.preferences }), [api]);
  return <CurrencyView model={model} />;
}

export function CurrencyView({ model }: { model: CurrencyModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  return (
    <Screen title={t('currency.title', locale)} subtitle={t('currency.subtitle', locale)} testID="screen-currency">
      {s.status === 'loading' || s.status === 'idle' ? <Skeleton /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="currency-notice" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} testID="currency-error" /> : null}
      {s.status === 'ready' ? (
        <Card>
          {RECEIVE_OPTIONS.map((o, i) => (
            <ListRow
              key={o.value}
              title={t(o.label, locale)}
              {...(o.helper ? { subtitle: t(o.helper, locale) } : {})}
              {...(s.receiveCurrency === o.value ? { trailing: '✓' } : {})}
              onPress={() => void model.choose(o.value)}
              accessibilityLabel={t(o.label, locale)}
              testID={`currency-${o.value}`}
              last={i === RECEIVE_OPTIONS.length - 1}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

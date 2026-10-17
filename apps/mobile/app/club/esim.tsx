// M26 eSIM plans + checkout confirm. Edge: device not eSIM-capable; empty; feature off.
import { useEffect, useMemo } from 'react';
import { format } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Badge, Banner, Button, Card, EmptyState, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { useNow } from '../../src/clock.ts';
import { useDevice } from '../../src/device.ts';
import { intlLocale, t, useLocale } from '../../src/i18n.ts';
import { useOpener } from '../../src/linking.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { createEsimModel, type EsimModel } from './esim.model.ts';
import { uuidv7 } from '@kesher/domain';

export function useEsimModel(): EsimModel {
  const api = useApi();
  const device = useDevice();
  const opener = useOpener();
  const router = useRouter();
  const now = useNow();
  return useMemo(() => createEsimModel({ club: api.club, esim: api.esim, device, opener, router, now, newKey: uuidv7 }), [api, device, opener, router, now]);
}

export default function EsimPlansScreen() {
  return <EsimPlansView model={useEsimModel()} />;
}

export function EsimPlansView({ model }: { model: EsimModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.loadPlans(), [model]);

  if (s.checkout) {
    const c = s.checkout;
    return (
      <Screen
        title={t('checkout.title', locale)}
        subtitle={c.plan.title}
        testID="screen-esim-checkout"
        footer={
          <>
            <Button label={t(c.creditApplied ? 'checkout.buyFree' : 'checkout.buy', locale)} onPress={() => void model.buy()} loading={s.busy} testID="esim-buy" />
            <Button label={t('common.back', locale)} variant="tertiary" onPress={model.clearSelection} disabled={s.busy} />
          </>
        }
      >
        {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
        <Card>
          <ListRow title={t('checkout.price', locale)} trailing={format(c.plan.price, intlLocale(locale))} />
          {c.creditApplied ? <ListRow title={t('checkout.credit', locale, { n: c.plan.dataGb ?? '', unit: s.credit?.unit ?? 'GB' })} trailing={`-${format(c.plan.price, intlLocale(locale))}`} /> : null}
          <ListRow title={t('checkout.total', locale)} trailing={format(c.total, intlLocale(locale))} last />
        </Card>
        {s.busy ? <Txt tone="secondary">{t('checkout.buying', locale)}</Txt> : null}
      </Screen>
    );
  }

  return (
    <Screen title={t('esim.title', locale)} subtitle={t('esim.subtitle', locale)} testID="screen-esim-plans">
      {s.status === 'loading' ? <Skeleton /> : null}
      {s.status === 'notCapable' ? <EmptyState title={t('esim.notCapable.title', locale)} body={t('esim.notCapable.body', locale)} /> : null}
      {s.status === 'empty' ? <EmptyState title={t('esim.empty.title', locale)} body={t('esim.empty.body', locale)} /> : null}
      {s.status === 'error' && s.error ? <Banner tone="warning" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.loadPlans() }} /> : null}
      {s.status === 'ready' && s.credit && s.credit.remaining > 0 ? <Badge label={t('esim.credit.left', locale, { n: s.credit.remaining, unit: s.credit.unit })} tone="success" /> : null}
      {s.status === 'ready' ? (
        <Card>
          {s.plans.map((p, i) => (
            <ListRow
              key={p.sku}
              title={p.title}
              subtitle={[p.dataGb ? t('esim.row.data', locale, { gb: p.dataGb }) : undefined, p.days ? t('esim.row.days', locale, { days: p.days }) : undefined, p.covered ? t('esim.credit.badge', locale) : undefined].filter(Boolean).join(' · ')}
              trailing={p.covered && (s.credit?.remaining ?? 0) > 0 ? t('checkout.buyFree', locale) : format(p.price, intlLocale(locale))}
              onPress={() => model.select(p.sku)}
              testID={`plan-${p.sku}`}
              last={i === s.plans.length - 1}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

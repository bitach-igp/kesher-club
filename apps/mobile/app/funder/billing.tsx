// P13 billing in funder mode (T-0311): each membership the funder pays for, with who, plan, price and when it renews
// or ends. Cancel asks once, in place, and says what happens before anything is sent.
import { useEffect, useMemo } from 'react';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { fmt } from './plans.model.ts';
import { createBillingModel, dateText, type BillingModel } from './billing.model.ts';

export default function BillingScreen() {
  const api = useApi();
  const model = useMemo(() => createBillingModel({ funder: api.funder, newKey: uuidv7 }), [api]);
  return <BillingView model={model} />;
}

export function BillingView({ model }: { model: BillingModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('billing.title', locale)} testID="screen-billing">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'error') {
    return (
      <Screen title={t('billing.title', locale)} testID="screen-billing-error" footer={<Button label={t('common.retry', locale)} onPress={() => void model.load()} testID="billing-retry" />}>
        <Banner tone="danger" body={t(s.error ?? 'common.error.generic', locale)} />
      </Screen>
    );
  }
  if (s.mode === 'empty') {
    return (
      <Screen title={t('billing.title', locale)} testID="screen-billing-empty">
        <EmptyState title={t('billing.title', locale)} body={t('billing.empty', locale)} />
      </Screen>
    );
  }
  return (
    <Screen title={t('billing.title', locale)} testID="screen-billing">
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="billing-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="billing-notice" /> : null}
      {s.rows.map((r) => (
        <Card key={r.id} testID={`billing-${r.id}`}>
          {/* The member's own display name, shown as written. */}
          <Txt variant="headline">{r.name ? t('billing.for', locale, { name: r.name }) : t('billing.someone', locale)}</Txt>
          <Txt tone="secondary">{t('billing.plan', locale, { plan: r.planCode })}</Txt>
          <Txt variant="title2" tabular>
            {fmt(r.price, locale)}
          </Txt>
          <Txt tone={r.status === 'past_due' ? 'danger' : 'secondary'} testID={`billing-line-${r.id}`}>
            {t(r.line.key, locale, r.line.date ? { date: dateText(r.line.date, locale) } : {})}
          </Txt>
          {s.confirming === r.id ? (
            <>
              <Banner tone="warning" body={t('billing.cancel.confirm', locale)} testID={`billing-confirm-${r.id}`} />
              <Button label={t('billing.cancel.yes', locale)} variant="destructive" onPress={() => void model.confirmCancel()} loading={s.busy} disabled={s.busy} testID={`billing-yes-${r.id}`} />
              <Button label={t('billing.cancel.keep', locale)} variant="tertiary" onPress={model.keep} disabled={s.busy} testID={`billing-keep-${r.id}`} />
            </>
          ) : r.cancellable ? (
            <Button label={t('billing.cancel', locale)} variant="secondary" onPress={() => model.askCancel(r.id)} disabled={s.busy} testID={`billing-cancel-${r.id}`} />
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}

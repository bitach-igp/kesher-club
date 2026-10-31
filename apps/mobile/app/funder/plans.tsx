// P01–P03 in funder mode (T-0308): the plans on offer in a market side by side, a card saved on the billing vendor's
// sheet, then on to P04. Before the funder's T1 is approved, Continue goes to identity verification first.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { useTheme } from '../../src/theme.ts';
import { createPlansModel, fmt, type CardSheet, type Market, type PlansModel } from './plans.model.ts';

const MARKETS: readonly Market[] = ['US', 'IL'];

/**
 * The card sheet this build binds: the billing simulator's sheets complete at once, as the simulator saves no card
 * data; any other is the live vendor's, which the live adapter's card (T-0301) binds, so until then nothing is saved.
 */
export const simulatorCardSheet: CardSheet = { present: async (clientSecret) => (clientSecret.endsWith('_secret_sim') ? 'completed' : 'cancelled') };

export function usePlansModel(): PlansModel {
  const api = useApi();
  const router = useRouter();
  return useMemo(() => createPlansModel({ funder: api.funder, kyc: api.kyc, sheet: simulatorCardSheet, router }), [api, router]);
}

export default function FunderPlansScreen() {
  return <FunderPlansView model={usePlansModel()} />;
}

export function FunderPlansView({ model }: { model: PlansModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const th = useTheme();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('funder.plans.title', locale)} testID="screen-funder-plans">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'error') {
    return (
      <Screen title={t('funder.plans.title', locale)} testID="screen-funder-plans-error" footer={<Button label={t('common.retry', locale)} onPress={() => void model.load()} testID="funder-plans-retry" />}>
        <Banner tone="danger" body={t(s.error ?? 'common.error.generic', locale)} />
      </Screen>
    );
  }
  return (
    <Screen
      title={t('funder.plans.title', locale)}
      subtitle={t('funder.plans.subtitle', locale)}
      testID="screen-funder-plans"
      footer={<Button label={t(s.verified ? 'funder.next' : 'funder.verify.action', locale)} onPress={model.next} disabled={s.busy} testID="funder-next" />}
    >
      {!s.verified ? <Banner tone="info" body={t('funder.verify.needed', locale)} testID="funder-verify" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="funder-error" /> : null}
      {s.notice ? <Banner tone="warning" body={t(s.notice, locale)} testID="funder-notice" /> : null}
      <View style={{ flexDirection: 'row', gap: th.space[2] }}>
        {MARKETS.map((m) => (
          <Button key={m} label={t(`funder.market.${m}`, locale)} variant={m === s.market ? 'primary' : 'secondary'} onPress={() => void model.setMarket(m)} testID={`funder-market-${m}`} />
        ))}
      </View>
      {s.plans.length === 0 ? <EmptyState title={t('funder.plans.none', locale)} body="" /> : null}
      {s.plans.map((p) => (
        <Card key={p.planCode} testID={`funder-plan-${p.planCode}`}>
          {/* Plan names are finance's text, shown as written. */}
          <Txt variant="headline">{p.name}</Txt>
          <Txt variant="title1" tabular>
            {t('funder.plan.monthly', locale, { price: fmt(p.monthly, locale) })}
          </Txt>
          <Txt tone="secondary">{t('funder.plan.price', locale, { price: fmt(p.price, locale), months: p.termMonths })}</Txt>
          {p.includes.map((i) => (
            <Txt key={i.key}>{t(i.key, locale, i.vars)}</Txt>
          ))}
          <Button label={t(p.planCode === s.chosen ? 'funder.plan.chosen' : 'funder.plan.choose', locale)} variant={p.planCode === s.chosen ? 'primary' : 'secondary'} onPress={() => model.choose(p.planCode)} testID={`funder-choose-${p.planCode}`} />
        </Card>
      ))}
      <Card testID="funder-card">
        {s.cardSaved ? <Txt>{t('funder.card.saved', locale)}</Txt> : <Button label={t('funder.card.save', locale)} variant="secondary" onPress={() => void model.saveCard()} disabled={s.busy} testID="funder-card-save" />}
      </Card>
    </Screen>
  );
}

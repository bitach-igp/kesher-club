// M08 home: balances per purse (with the on-hold row when money is reserved), the identity card while
// verification is unfinished, the frozen-card banner, and recent activity. Merchant text is data.
// T-0911: the incident banner while a money capability is degraded (text only) and the quick actions
// for capabilities that are ok.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { useNow } from '../../src/clock.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { createHomeModel, declinedCopy, fmt, frozenCard, incidentBanner, kycCard, purseRows, quickActions, signedAmount, type HomeModel } from './home.model.ts';

export function useHomeModel(): HomeModel {
  const api = useApi();
  const router = useRouter();
  const now = useNow();
  const locale = useLocale();
  return useMemo(() => createHomeModel({ wallet: api.wallet, kyc: api.kyc, cards: api.cards, status: api.status, proposals: api.proposals, displayName: api.displayName, router, now, locale }), [api, router, now, locale]);
}

export default function HomeScreen() {
  return <HomeView model={useHomeModel()} />;
}

export function HomeView({ model }: { model: HomeModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => void model.load(), [model]);
  if (s.mode === 'loading') {
    return (
      <Screen title={t('home.title', locale)} testID="screen-home">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'error') {
    return (
      <Screen title={t('home.title', locale)} testID="screen-home-error" footer={<Button label={t('common.retry', locale)} onPress={() => void model.load()} testID="home-retry" />}>
        <Banner tone="danger" body={t(s.error ?? 'common.error.generic', locale)} />
      </Screen>
    );
  }
  const identity = kycCard(s.kyc);
  const frozen = frozenCard(s.cards);
  const recent = model.groups().flatMap((g) => g.items).slice(0, 5);
  const incident = incidentBanner(s.service);
  const actions = quickActions(s.service);
  return (
    <Screen title={t('home.title', locale)} testID="screen-home">
      {/* Staff-written incident copy, shown as text: no action, no link. */}
      {incident ? <Banner tone="warning" title={incident.title} body={incident.body} testID="home-incident" /> : null}
      {identity ? <Banner tone={identity.tone} title={t('home.kyc.title', locale)} body={t(identity.body, locale)} {...(identity.action ? { action: { label: t('home.kyc.action', locale), onPress: model.goVerify } } : {})} testID="home-kyc" /> : null}
      {frozen ? <Banner tone="danger" body={t('home.card.frozen', locale)} action={{ label: t('home.card.action', locale), onPress: model.goCard }} testID="home-frozen" /> : null}
      {s.proposalsWaiting > 0 ? <Banner tone="info" body={t(s.proposalsWaiting === 1 ? 'home.proposals' : 'home.proposalsMany', locale, { count: s.proposalsWaiting })} action={{ label: t('home.proposals.open', locale), onPress: model.goProposals }} testID="home-proposals" /> : null}
      {purseRows(s.accounts).map((p) => (
        <Card key={p.accountId} testID={`home-purse-${p.currency}`}>
          <Txt variant="caption" tone="secondary">
            {t('home.purse.available', locale)} · {p.currency}
          </Txt>
          <Txt variant="title1" tabular>
            {fmt(p.available, locale)}
          </Txt>
          {p.hasHolds ? (
            <Txt tone="secondary" testID={`home-holds-${p.currency}`}>
              {t('home.purse.holds', locale, { amount: fmt(p.holds, locale) })}
            </Txt>
          ) : null}
          <Button label={t('home.seeAll', locale)} variant="tertiary" onPress={() => model.goWallet(p.accountId)} testID={`home-wallet-${p.currency}`} />
        </Card>
      ))}
      <Card testID="home-settings">
        <ListRow title={t('home.receiveIn', locale)} onPress={model.goReceiveIn} testID="home-receive-in" />
        {/* Member text, shown as written. */}
        <ListRow title={t('home.yourName', locale)} subtitle={s.displayName ?? t('home.yourName.notSet', locale)} onPress={model.goName} last testID="home-your-name" />
      </Card>
      {actions.length ? (
        <Card testID="home-quick">
          <Txt variant="headline">{t('home.quick.title', locale)}</Txt>
          {actions.map((q, i) => (
            <ListRow key={q.action} title={t(q.label, locale)} onPress={() => router.push(q.href)} last={i === actions.length - 1} testID={`home-quick-${q.action}`} />
          ))}
        </Card>
      ) : null}
      <Card testID="home-recent">
        <Txt variant="headline">{t('home.recent', locale)}</Txt>
        {s.activityUnavailable ? <Txt tone="secondary">{t('home.unavailable', locale)}</Txt> : null}
        {recent.map((tx, i) => {
          const declined = declinedCopy(tx);
          return (
            <ListRow
              key={tx.id}
              title={tx.counterparty ?? t(`tx.kind.${tx.kind}`, locale)}
              subtitle={declined ? t('tx.declined.title', locale) : t(`tx.state.${tx.state}`, locale)}
              trailing={fmt(signedAmount(tx), locale)}
              onPress={() => router.push(`/wallet/transaction?id=${encodeURIComponent(tx.id)}&account=${encodeURIComponent(s.selectedAccountId ?? '')}`)}
              last={i === recent.length - 1}
              testID={`home-tx-${tx.id}`}
            />
          );
        })}
      </Card>
    </Screen>
  );
}

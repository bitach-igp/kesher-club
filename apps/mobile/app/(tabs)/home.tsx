// M08 home: balances per purse (with the on-hold row when money is reserved), the identity card while
// verification is unfinished, the frozen-card banner, and recent activity. Merchant text is data.
// T-0911: the incident banner while a money capability is degraded (text only) and the quick actions
// for capabilities that are ok.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { useNow } from '../../src/clock.ts';
import { Pressable, StyleSheet, View } from 'react-native';
import { Banner, BalanceHero, Button, Card, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { useTheme } from '../../src/theme.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { createHomeModel, declinedCopy, fmt, frozenCard, greeting, heroActions, heroOf, HERO_ACTIONS, incidentBanner, kycCard, purseRows, quickActions, signedAmount, type HomeModel } from './home.model.ts';

/** A short decorative glyph above each quick action's label (hidden from screen readers). */
const GLYPH: Record<string, string> = { add: '+', send: '↗', convert: '⇄', card: '▭', requests: '≡' };

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
  const actions = quickActions(s.service).filter((q) => !HERO_ACTIONS.includes(q.action));
  const row = heroActions(s.service);
  const hero = heroOf(s.accounts);
  const purses = purseRows(s.accounts);
  const hi = greeting(s.displayName);
  return (
    <Screen title={t('home.title', locale)} testID="screen-home">
      {/* Staff-written incident copy, shown as text: no action, no link. */}
      {incident ? <Banner tone="warning" title={incident.title} body={incident.body} testID="home-incident" /> : null}
      {identity ? <Banner tone={identity.tone} title={t('home.kyc.title', locale)} body={t(identity.body, locale)} {...(identity.action ? { action: { label: t('home.kyc.action', locale), onPress: model.goVerify } } : {})} testID="home-kyc" /> : null}
      {frozen ? <Banner tone="danger" body={t('home.card.frozen', locale)} action={{ label: t('home.card.action', locale), onPress: model.goCard }} testID="home-frozen" /> : null}
      {s.proposalsWaiting > 0 ? <Banner tone="info" body={t(s.proposalsWaiting === 1 ? 'home.proposals' : 'home.proposalsMany', locale, { count: s.proposalsWaiting })} action={{ label: t('home.proposals.open', locale), onPress: model.goProposals }} testID="home-proposals" /> : null}
      <Txt variant="title2" testID="home-greeting">
        {t(hi.key, locale, hi.vars)}
      </Txt>
      <BalanceHero
        label={t('home.hero.label', locale)}
        ils={hero.ils}
        {...(hero.usd ? { usd: hero.usd } : {})}
        {...(purses.length
          ? {
              purses: purses.map((p) => ({
                currency: p.currency,
                available: p.available,
                ...(p.hasHolds ? { holds: p.holds, holdsText: t('home.purse.holds', locale, { amount: fmt(p.holds, locale) }) } : {}),
                availableLabel: `${t('home.purse.available', locale)} · ${p.currency}`,
                seeAllLabel: t('home.seeAll', locale),
                onOpen: () => model.goWallet(p.accountId),
              })),
            }
          : {})}
        testID="home-hero"
      />
      {hero.empty ? (
        <Card testID="home-empty">
          <Txt variant="headline">{t('home.empty.title', locale)}</Txt>
          <Txt tone="secondary">{t('home.empty.body', locale)}</Txt>
        </Card>
      ) : null}
      {row.length ? <QuickRow items={row.map((q) => ({ key: q.action, label: t(q.label, locale), href: q.href }))} onGo={(href) => router.push(href)} /> : null}
      <Card testID="home-settings">
        <ListRow title={t('home.receiveIn', locale)} onPress={model.goReceiveIn} testID="home-receive-in" />
        {/* Member text, shown as written. */}
        <ListRow title={t('home.yourName', locale)} subtitle={s.displayName ?? t('home.yourName.notSet', locale)} onPress={model.goName} last testID="home-your-name" />
      </Card>
      {/* Funder mode (decision 1): any signed-in adult may pay for someone's membership (T-0308). */}
      <Card testID="home-funder">
        <ListRow title={t('family.entry', locale)} onPress={() => router.push('/funder/family')} testID="home-family" />
        <ListRow title={t('funder.entry', locale)} onPress={() => router.push('/funder/plans')} last testID="home-funder-entry" />
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

/** The four-up quick-action row under the hero: each a 44-point target with a glyph over its label. */
function QuickRow({ items, onGo }: { items: readonly { key: string; label: string; href: string }[]; onGo(href: string): void }) {
  const th = useTheme();
  return (
    <View style={[styles.row, { gap: th.space[2] }]} testID="home-quick-row">
      {items.map((q) => (
        <Pressable key={q.key} accessibilityRole="button" accessibilityLabel={q.label} onPress={() => onGo(q.href)} testID={`home-quick-${q.key}`} style={[styles.item, { minHeight: 44, padding: th.space[2], borderRadius: th.radius.md, backgroundColor: th.color.action.primarySubtle }]}>
          <Txt variant="callout" tone="action" accessibilityElementsHidden importantForAccessibility="no">
            {GLYPH[q.key] ?? '•'}
          </Txt>
          <Txt variant="micro" tone="action">
            {q.label}
          </Txt>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignSelf: 'stretch' }, item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 } });


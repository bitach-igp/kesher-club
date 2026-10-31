// P06 child detail (T-0538): this month's spend by category as bars, in dollars with shekels one tap away, the recent
// transactions in plain words, and the member's cards with Controls (P09). No names or notes from P2P: the API sends none.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useTheme } from '../../src/theme.ts';
import { fmt } from './plans.model.ts';
import { createMemberModel, type MemberModel } from './member.model.ts';

export default function MemberScreen() {
  const api = useApi();
  const router = useRouter();
  const id = useParams()['id'] ?? '';
  const model = useMemo(() => createMemberModel({ funder: api.funder, router }, id), [api, router, id]);
  return <MemberView model={model} />;
}

export function MemberView({ model }: { model: MemberModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const th = useTheme();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('member.title', locale)} testID="screen-member">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'error') {
    return (
      <Screen title={t('member.title', locale)} testID="screen-member-error" footer={<Button label={t('common.retry', locale)} onPress={() => void model.load()} testID="member-retry" />}>
        <Banner tone="danger" body={t(s.error ?? 'common.error.generic', locale)} />
      </Screen>
    );
  }
  const other = s.shown === 'USD' ? 'ILS' : 'USD';
  return (
    <Screen title={s.name} testID="screen-member">
      <Card testID="member-spend">
        <Txt variant="headline">{t('member.spend.title', locale)}</Txt>
        <Button label={t('family.showIn', locale, { currency: other })} variant="tertiary" onPress={model.toggleCurrency} testID="member-currency" />
        {s.bars.length === 0 ? <Txt tone="secondary">{t('member.spend.none', locale)}</Txt> : null}
        {s.bars.map((b) => (
          <View key={b.category} testID={`member-bar-${b.category}`} style={{ gap: th.space[1] }}>
            <Txt>
              {t(`member.category.${b.category}`, locale)} · {fmt(b.amount, locale)}
            </Txt>
            <View style={{ height: th.space[2], width: `${Math.max(b.percent, 2)}%`, backgroundColor: th.color.action.primary, borderRadius: th.radius.full }} />
          </View>
        ))}
      </Card>
      {s.cards.length ? (
        <Card testID="member-cards">
          <Txt variant="headline">{t('member.cards.title', locale)}</Txt>
          {s.cards.map((c, i) => (
            <ListRow key={c.id} title={t('member.card', locale, { last4: c.last4 })} subtitle={t(`member.card.${c.status === 'frozen' ? 'frozen' : 'active'}`, locale)} onPress={() => model.openControls(c.id)} last={i === s.cards.length - 1} testID={`member-card-${c.id}`} />
          ))}
        </Card>
      ) : null}
      <Card testID="member-transactions">
        <Txt variant="headline">{t('member.tx.title', locale)}</Txt>
        {s.rows.length === 0 ? <Txt tone="secondary">{t('member.tx.none', locale)}</Txt> : null}
        {s.rows.map((r, i) => (
          <ListRow key={r.id} title={t(r.title, locale)} subtitle={t(`tx.state.${r.state}`, locale)} trailing={fmt(r.amount, locale)} last={i === s.rows.length - 1} testID={`member-tx-${r.id}`} />
        ))}
      </Card>
    </Screen>
  );
}

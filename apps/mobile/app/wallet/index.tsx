// M09 balance detail: one purse's available and on-hold amounts and its activity grouped by day, with
// a kind filter, a text search over merchant and member text (as text), and paging.
import { useEffect } from 'react';
import { Button, Card, EmptyState, ListRow, Screen, Skeleton, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useHomeModel } from '../(tabs)/home.tsx';
import { declinedCopy, FILTERS, fmt, purseRows, signedAmount, type HomeModel } from '../(tabs)/home.model.ts';

export default function WalletScreen() {
  const params = useParams();
  return <WalletView model={useHomeModel()} accountId={params['account']} />;
}

export function WalletView({ model, accountId }: { model: HomeModel; accountId: string | undefined }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => {
    void model.load().then(() => (accountId ? model.selectAccount(accountId) : undefined));
  }, [model, accountId]);
  if (s.mode === 'loading') {
    return (
      <Screen title={t('wallet.title', locale)} testID="screen-wallet">
        <Skeleton />
      </Screen>
    );
  }
  const purse = purseRows(s.accounts).find((p) => p.accountId === (accountId ?? s.selectedAccountId));
  const groups = model.groups(accountId);
  const all = (accountId ? s.transactions[accountId] : undefined) ?? [];
  const cursor = accountId ? s.cursors[accountId] : undefined;
  return (
    <Screen title={t('wallet.title', locale)} {...(purse ? { subtitle: `${purse.currency} · ${fmt(purse.available, locale)}` } : {})} testID="screen-wallet" {...(cursor ? { footer: <Button label={t('wallet.loadMore', locale)} variant="secondary" onPress={() => void model.loadMore()} loading={s.busy} testID="wallet-more" /> } : {})}>
      {purse?.hasHolds ? (
        <Card testID="wallet-holds">
          <Txt variant="caption" tone="secondary">
            {t('home.purse.onHold', locale)}
          </Txt>
          <Txt variant="title2" tabular>
            {fmt(purse.holds, locale)}
          </Txt>
        </Card>
      ) : null}
      <TextField label={t('wallet.search', locale)} value={s.query} onChangeText={model.setQuery} autoCorrect={false} testID="wallet-search" />
      <Card>
        {FILTERS.map((f, i) => (
          <ListRow key={f} title={t(`wallet.filter.${f}`, locale)} {...(s.filter === f ? { trailing: '✓' } : {})} onPress={() => model.setFilter(f)} last={i === FILTERS.length - 1} testID={`wallet-filter-${f}`} />
        ))}
      </Card>
      {all.length === 0 ? <EmptyState title={t('wallet.empty.title', locale)} body={t(s.activityUnavailable ? 'home.unavailable' : 'wallet.empty.body', locale)} /> : null}
      {all.length > 0 && groups.length === 0 ? <Txt tone="secondary">{t('wallet.empty.filtered', locale)}</Txt> : null}
      {groups.map((g) => (
        <Card key={g.day} testID={`wallet-day-${g.day}`}>
          <Txt variant="headline">{'key' in g.label ? t(g.label.key, locale) : g.label.date}</Txt>
          {g.items.map((tx, i) => {
            const declined = declinedCopy(tx);
            return (
              <ListRow
                key={tx.id}
                title={tx.counterparty ?? t(`tx.kind.${tx.kind}`, locale)}
                subtitle={declined ? t('tx.declined.title', locale) : t(`tx.state.${tx.state}`, locale)}
                trailing={fmt(signedAmount(tx), locale)}
                onPress={() => router.push(`/wallet/transaction?id=${encodeURIComponent(tx.id)}&account=${encodeURIComponent(accountId ?? '')}`)}
                last={i === g.items.length - 1}
                testID={`wallet-tx-${tx.id}`}
              />
            );
          })}
        </Card>
      ))}
    </Screen>
  );
}

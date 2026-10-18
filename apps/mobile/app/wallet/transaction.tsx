// M10 transaction detail: kind, state, amount, when, the counterparty, a declined purchase's reason
// in plain words, and whatever the merchant sent, shown as the text it is.
import { useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { intlLocale, t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useHomeModel } from '../(tabs)/home.tsx';
import { declinedCopy, fmt, signedAmount, type HomeModel } from '../(tabs)/home.model.ts';

export default function TransactionScreen() {
  const params = useParams();
  return <TransactionView model={useHomeModel()} id={params['id'] ?? ''} accountId={params['account']} />;
}

export function TransactionView({ model, id, accountId }: { model: HomeModel; id: string; accountId: string | undefined }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const router = useRouter();
  const [searched, setSearched] = useState(false);
  useEffect(() => {
    setSearched(false);
    void (async () => {
      await model.load();
      if (accountId) await model.selectAccount(accountId);
      // The row may sit on a page the list screen fetched and this screen has not: page until it turns up.
      await model.locate(id, accountId);
      setSearched(true);
    })();
  }, [model, accountId, id]);
  const tx = model.transaction(id);
  if (s.mode === 'loading' || (!tx && (s.busy || !searched))) {
    return (
      <Screen title={t('tx.title', locale)} testID="screen-tx">
        <Skeleton />
      </Screen>
    );
  }
  if (!tx) {
    return (
      <Screen title={t('tx.title', locale)} testID="screen-tx-missing" footer={<Button label={t('common.back', locale)} variant="secondary" onPress={router.back} />}>
        <Banner tone="warning" body={t('common.error.generic', locale)} />
      </Screen>
    );
  }
  const declined = declinedCopy(tx);
  const when = new Date(tx.at).toLocaleString(intlLocale(locale));
  return (
    <Screen title={t(`tx.kind.${tx.kind}`, locale)} subtitle={fmt(signedAmount(tx), locale)} testID="screen-tx" footer={<Button label={t('tx.help', locale)} variant="tertiary" onPress={() => router.push('/help')} testID="tx-help" />}>
      <Badge label={t(`tx.state.${tx.state}`, locale)} />
      {declined ? <Banner tone="warning" title={t('tx.declined.title', locale)} body={t(declined.key, locale, declined.vars)} testID="tx-declined" /> : null}
      <Card>
        <Txt variant="caption" tone="secondary">
          {t('tx.when', locale)}
        </Txt>
        <Txt>{when}</Txt>
        {tx.counterparty ? (
          <>
            <Txt variant="caption" tone="secondary">
              {t('tx.counterparty', locale)}
            </Txt>
            <Txt testID="tx-counterparty">{tx.counterparty}</Txt>
          </>
        ) : null}
      </Card>
      {tx.untrusted && Object.keys(tx.untrusted).length ? (
        <Card testID="tx-untrusted">
          <Txt variant="caption" tone="secondary">
            {t('tx.details', locale)}
          </Txt>
          {Object.entries(tx.untrusted).map(([k, v]) => (
            <Txt key={k} tone="secondary">
              {k}: {v}
            </Txt>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

// M14 amount: the purse to pay from (each with what is available), the sum and an optional note (member
// text, sent as written). The balance check here is a courtesy; the server's answer on confirm counts.
import { useEffect } from 'react';
import { Banner, Button, Card, ListRow, Screen, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import { formatMoney, purseOptions, type PayModel } from './pay.model.ts';

export default function AmountScreen() {
  return <AmountView model={usePayModel()} />;
}

export function AmountView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  const purses = purseOptions(s.accounts);
  return (
    <Screen title={t('pay.amount.title', locale)} testID="screen-pay-amount" footer={<Button label={t('common.continue', locale)} onPress={model.goConfirm} disabled={!s.amountText.trim()} testID="amount-continue" />}>
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="amount-error" /> : null}
      {purses.length ? (
        <Card testID="amount-purses">
          <Txt variant="caption" tone="secondary">
            {t('pay.amount.purse', locale)}
          </Txt>
          {purses.map((p, i) => (
            <ListRow
              key={p.currency}
              title={t(p.currency === 'ILS' ? 'currency.ils' : 'currency.usd', locale)}
              subtitle={t('pay.amount.purseAvailable', locale, { available: formatMoney(p.available, locale) })}
              {...(s.currency === p.currency ? { trailing: '✓' } : {})}
              onPress={() => model.setCurrency(p.currency)}
              testID={`amount-purse-${p.currency}`}
              last={i === purses.length - 1}
            />
          ))}
        </Card>
      ) : null}
      <TextField label={t('pay.amount.label', locale)} value={s.amountText} onChangeText={model.setAmount} keyboardType="decimal-pad" testID="amount-input" />
      <TextField label={t('pay.amount.note', locale)} helper={t('pay.amount.noteHelper', locale)} value={s.note} onChangeText={model.setNote} maxLength={140} testID="amount-note" />
    </Screen>
  );
}

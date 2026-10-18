// M14 amount: the sum and an optional note (member text, sent as written). The balance check here is
// a courtesy; the server's answer on confirm is the one that counts.
import { Banner, Button, Screen, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import { available, formatMoney, type PayModel } from './pay.model.ts';

export default function AmountScreen() {
  return <AmountView model={usePayModel()} />;
}

export function AmountView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  return (
    <Screen title={t('pay.amount.title', locale)} testID="screen-pay-amount" footer={<Button label={t('common.continue', locale)} onPress={model.goConfirm} disabled={!s.amountText.trim()} testID="amount-continue" />}>
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="amount-error" /> : null}
      <Txt tone="secondary">
        {t('pay.home.balance', locale)}: {formatMoney(available(s.accounts, s.currency), locale)}
      </Txt>
      <TextField label={t('pay.amount.label', locale)} value={s.amountText} onChangeText={model.setAmount} keyboardType="decimal-pad" testID="amount-input" />
      <TextField label={t('pay.amount.note', locale)} helper={t('pay.amount.noteHelper', locale)} value={s.note} onChangeText={model.setNote} maxLength={140} testID="amount-note" />
    </Screen>
  );
}

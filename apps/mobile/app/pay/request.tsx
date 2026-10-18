// M16 request: ask a member for a sum, payable for 14 days.
import { Banner, Button, Screen, TextField } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import type { PayModel } from './pay.model.ts';

export default function RequestScreen() {
  return <RequestView model={usePayModel()} />;
}

export function RequestView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  return (
    <Screen title={t('pay.request.title', locale)} testID="screen-pay-request" footer={<Button label={t('pay.request.action', locale)} onPress={() => void model.request()} loading={s.busy} disabled={!s.recipient.trim() || !s.amountText.trim()} testID="request-send" />}>
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="request-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="request-notice" /> : null}
      <TextField label={t('pay.recipient.label', locale)} value={s.recipient} onChangeText={model.setRecipient} autoCapitalize="none" autoCorrect={false} testID="request-recipient" />
      <TextField label={t('pay.amount.label', locale)} value={s.amountText} onChangeText={model.setAmount} keyboardType="decimal-pad" testID="request-amount" />
      <TextField label={t('pay.amount.note', locale)} helper={t('pay.amount.noteHelper', locale)} value={s.note} onChangeText={model.setNote} maxLength={140} testID="request-note" />
    </Screen>
  );
}

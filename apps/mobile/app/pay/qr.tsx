// M19 my code: the member's pay code, with an optional fixed amount. Scanning lives on M13.
import { QrCode, Screen, TextField } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import type { PayModel } from './pay.model.ts';

export default function QrScreen() {
  return <QrView model={usePayModel()} />;
}

export function QrView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  return (
    <Screen title={t('pay.qr.title', locale)} subtitle={t('pay.qr.body', locale)} testID="screen-pay-qr">
      <QrCode payload={model.qrPayload()} label={t('pay.qr.label', locale)} />
      <TextField label={t('pay.qr.amount', locale)} value={s.qrAmountText} onChangeText={model.setQrAmount} keyboardType="decimal-pad" testID="qr-amount" />
    </Screen>
  );
}

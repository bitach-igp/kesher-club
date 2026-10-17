// M24 activation: the last four digits printed on the delivered card, under a fresh passkey
// step-up; the PIN is then set inside the processor's SDK and never passes through the app.
import { useEffect } from 'react';
import { Banner, Button, Screen, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { shippingView, type CardModel } from './card.model.ts';
import { useCardModel } from './index.tsx';

export default function ActivateCardScreen() {
  return <ActivateCardView model={useCardModel()} />;
}

export function ActivateCardView({ model }: { model: CardModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void (s.mode === 'loading' && model.load()), [model, s.mode]);
  const card = model.selected();
  const shipping = card ? shippingView(card) : undefined;
  return (
    <Screen title={t('card.activate.title', locale)} subtitle={t('card.activate.body', locale)} testID="screen-card-activate" footer={<Button label={t('card.activate.action', locale)} onPress={() => void model.activate()} loading={s.busy} disabled={s.last4.length !== 4 || shipping?.activated === true} testID="activate-submit" />}>
      {s.needsStepUp ? <Banner tone="info" body={t('card.stepUp', locale)} testID="activate-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="activate-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="activate-done" /> : null}
      {shipping?.trackingUrl && !shipping.activated ? <Txt tone="secondary">{t('card.physical.tracking', locale)}: {shipping.trackingUrl}</Txt> : null}
      <TextField label={t('card.activate.last4', locale)} value={s.last4} onChangeText={model.setLast4} keyboardType="number-pad" maxLength={4} testID="activate-last4" />
    </Screen>
  );
}

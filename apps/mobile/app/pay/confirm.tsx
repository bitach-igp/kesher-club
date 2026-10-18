// M15 confirm: one Idempotency-Key per sheet, kept through the passkey step-up and a retry, so a double
// tap is one transfer. A held first payment shows the hold banner with cancel.
import { useEffect } from 'react';
import { Banner, Button, Card, Screen, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import { formatMoney, parseAmount, type PayModel } from './pay.model.ts';

export default function ConfirmScreen() {
  return <ConfirmView model={usePayModel()} />;
}

export function ConfirmView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => {
    void model.load();
    model.openConfirm();
    return () => model.closeConfirm();
  }, [model]);
  const parsed = parseAmount(s.amountText, s.currency);
  const amount = 'amount' in parsed ? formatMoney(parsed.amount, locale) : s.amountText;
  const held = s.result?.state === 'pending_hold';
  const done = s.result !== undefined && !held;
  return (
    <Screen
      title={t('pay.confirm.title', locale)}
      subtitle={t('pay.confirm.body', locale, { amount, to: s.recipient })}
      testID="screen-pay-confirm"
      footer={held ? <Button label={t('pay.hold.cancel', locale)} variant="destructive" onPress={() => void model.cancelHold()} loading={s.busy} testID="confirm-cancel-hold" /> : done ? undefined : <Button label={t('pay.confirm.send', locale, { amount })} onPress={() => void model.send()} loading={s.busy} testID="confirm-send" />}
    >
      {s.needsStepUp ? <Banner tone="info" body={t('pay.confirm.stepUp', locale)} testID="confirm-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="confirm-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="confirm-notice" /> : null}
      {held && s.result?.holdReleasesAt ? <Banner tone="warning" body={t('pay.hold.banner', locale, { until: new Date(s.result.holdReleasesAt).toLocaleString(locale === 'he' ? 'he-IL' : 'en-US') })} testID="confirm-hold" /> : null}
      {s.note ? (
        <Card>
          <Txt variant="caption" tone="secondary">
            {t('pay.amount.note', locale)}
          </Txt>
          <Txt>{s.note}</Txt>
        </Card>
      ) : null}
    </Screen>
  );
}

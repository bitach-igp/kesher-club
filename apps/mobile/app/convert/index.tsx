// M11 convert: amount and direction, a quote with rate, markup and total counting down 30 seconds,
// convert under the passkey step-up; an expired quote is replaced on its own.
import { useEffect, useMemo } from 'react';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { useNow } from '../../src/clock.ts';
import { Banner, Button, Card, Screen, Skeleton, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { available, createFxModel, fmt, markupPercent, other, type FxModel } from './fx.model.ts';

export function useFxModel(): FxModel {
  const api = useApi();
  const locale = useLocale();
  const now = useNow();
  return useMemo(() => createFxModel({ fx: api.fx, accounts: () => api.pay.listAccounts(), newKey: uuidv7, now, locale }), [api, locale, now]);
}

export default function ConvertScreen() {
  return <ConvertView model={useFxModel()} />;
}

export function ConvertView({ model }: { model: FxModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  useEffect(() => {
    if (!s.quote) return;
    const id = setInterval(() => model.tick(), 1000);
    return () => clearInterval(id);
  }, [model, s.quote]);
  if (s.mode === 'loading') {
    return (
      <Screen title={t('fx.title', locale)} testID="screen-convert">
        <Skeleton />
      </Screen>
    );
  }
  const footer = s.result ? (
    <Button label={t('fx.again', locale)} variant="secondary" onPress={model.reset} testID="fx-again" />
  ) : s.quote ? (
    <Button label={t('fx.confirm', locale)} onPress={() => void model.confirm()} loading={s.busy} testID="fx-confirm" />
  ) : (
    <Button label={t('fx.getQuote', locale)} onPress={() => void model.getQuote()} loading={s.busy} disabled={!s.amountText.trim()} testID="fx-quote" />
  );
  return (
    <Screen title={t('fx.title', locale)} subtitle={t('fx.subtitle', locale)} testID="screen-convert" footer={footer}>
      {s.needsStepUp ? <Banner tone="info" body={t('fx.stepUp', locale)} testID="fx-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="fx-error" /> : null}
      {s.notice ? <Banner tone={s.result ? 'success' : 'warning'} body={t(s.notice.key, locale, s.notice.vars)} testID="fx-notice" /> : null}
      <Card>
        <Txt variant="caption" tone="secondary">
          {t('fx.from', locale)}: {s.from} · {t('pay.home.balance', locale)} {fmt(available(s.accounts, s.from), locale)}
        </Txt>
        <Button label={`${t('fx.swap', locale)} → ${other(s.from)}`} variant="tertiary" onPress={model.swap} testID="fx-swap" />
        <TextField label={t('fx.amount.label', locale)} value={s.amountText} onChangeText={model.setAmount} keyboardType="decimal-pad" testID="fx-amount" />
      </Card>
      {s.quote ? (
        <Card testID="fx-quote-card">
          <Txt variant="title2">{t('fx.total', locale, { total: fmt(s.quote.total, locale) })}</Txt>
          <Txt tone="secondary">{t('fx.rate', locale, { rate: s.quote.rate })}</Txt>
          <Txt tone="secondary">{t('fx.markup', locale, { percent: markupPercent(s.quote.markupBps), markup: fmt(s.quote.markup, locale) })}</Txt>
          <Txt variant="caption" tone="secondary" testID="fx-countdown">
            {t('fx.countdown', locale, { s: s.secondsLeft })}
          </Txt>
        </Card>
      ) : null}
    </Screen>
  );
}

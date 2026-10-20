// P07 add money, one-time (T-0524): who, how much, which purse, how to pay; the club-rate quote when the
// purse is the other currency; the receipt with both amounts, the rate version and, for ACH, the hold.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { uuidv7, type Currency } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { useRouter } from '../../src/navigation.ts';
import { useNow } from '../../src/clock.ts';
import { Banner, Button, Card, Screen, Skeleton, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale, type Locale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useTheme } from '../../src/theme.ts';
import { createAddMoneyModel, crossCurrency, fmt, methodsFor, parseAmount, type AddMoneyModel, type PaymentSheet } from './add-money.model.ts';

const CURRENCIES: readonly Currency[] = ['USD', 'ILS'];

/** No provider sheet is bound yet: a load that needs the payer stops here and says so (live adapters add it). */
export const noPaymentSheet: PaymentSheet = { present: async () => 'cancelled' };

export function useAddMoneyModel(): AddMoneyModel {
  const api = useApi();
  const now = useNow();
  return useMemo(() => createAddMoneyModel({ fund: api.fund, fx: api.fx, capabilities: () => api.club.getCapabilities(), paymentSheet: noPaymentSheet, newKey: uuidv7, now }), [api, now]);
}

export default function AddMoneyScreen() {
  return <AddMoneyView model={useAddMoneyModel()} />;
}

const dateText = (iso: string, locale: Locale): string => new Date(iso).toLocaleDateString(locale === 'he' ? 'he-IL' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' });

function Choice<T extends string>({ options, value, label, onChoose, testID }: { options: readonly T[]; value: T; label: (o: T) => string; onChoose: (o: T) => void; testID: string }) {
  const th = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space[2] }}>
      {options.map((o) => (
        <Button key={o} label={label(o)} variant={o === value ? 'primary' : 'secondary'} onPress={() => onChoose(o)} testID={`${testID}-${o}`} />
      ))}
    </View>
  );
}

export function AddMoneyView({ model }: { model: AddMoneyModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => void model.load(), [model]);
  useEffect(() => {
    if (!s.quote) return;
    const id = setInterval(() => model.tick(), 1000);
    return () => clearInterval(id);
  }, [model, s.quote]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('fund.title', locale)} testID="screen-add-money">
        <Skeleton />
      </Screen>
    );
  }

  const parsed = parseAmount(s.amountText, s.currency);
  const amount = 'amount' in parsed ? fmt(parsed.amount, locale) : '';
  const needsQuote = crossCurrency(s) && !s.quote;
  const footer = s.receipt ? (
    <Button label={t('fund.again', locale)} variant="secondary" onPress={model.startOver} testID="fund-again" />
  ) : needsQuote ? (
    <Button label={t('fund.quote.get', locale)} onPress={() => void model.requote()} loading={s.busy} disabled={!s.amountText.trim()} testID="fund-quote" />
  ) : (
    <Button label={t('fund.confirm', locale, { amount })} onPress={() => void model.confirm()} loading={s.busy} disabled={!amount || !s.memberPartyId} testID="fund-confirm" />
  );

  return (
    <Screen title={t('fund.title', locale)} subtitle={t('fund.subtitle', locale)} testID="screen-add-money" footer={footer}>
      {s.needsStepUp ? <Banner tone="info" body={t('fund.stepUp', locale)} testID="fund-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="fund-error" /> : null}
      {s.notice ? <Banner tone="warning" body={t(s.notice.key, locale, s.notice.vars)} testID="fund-notice" /> : null}

      {s.receipt ? (
        <Card testID="fund-receipt">
          <Txt variant="title2">{t('fund.receipt.title', locale)}</Txt>
          <Txt testID="fund-receipt-paid">{t('fund.receipt.paid', locale, { paid: fmt(s.receipt.paid, locale) })}</Txt>
          <Txt testID="fund-receipt-credited">{t('fund.receipt.credited', locale, { credited: fmt(s.receipt.credited, locale) })}</Txt>
          {s.receipt.rateVersion !== undefined ? <Txt tone="secondary">{t('fund.receipt.rate', locale, { version: s.receipt.rateVersion })}</Txt> : null}
          {s.receipt.state === 'on_hold' && s.receipt.holdUntil ? <Banner tone="warning" body={t('fund.receipt.held', locale, { date: dateText(s.receipt.holdUntil, locale) })} testID="fund-receipt-hold" /> : null}
          {s.receipt.state === 'processing' ? <Banner tone="info" body={t('fund.receipt.processing', locale)} testID="fund-receipt-processing" /> : null}
        </Card>
      ) : (
        <>
          {s.members.length > 1 ? (
            <Card>
              <Txt variant="caption" tone="secondary">{t('fund.member.label', locale)}</Txt>
              <Choice options={s.members.map((m) => m.partyId)} value={s.memberPartyId ?? ''} label={(id) => { const m = s.members.find((x) => x.partyId === id); return m?.self ? t('fund.member.self', locale) : (m?.name ?? id); }} onChoose={model.setMember} testID="fund-member" />
            </Card>
          ) : s.members.length === 0 ? (
            <Banner tone="info" body={t('fund.member.none', locale)} testID="fund-no-member" />
          ) : null}
          <Card>
            <TextField label={t('fund.amount.label', locale)} value={s.amountText} onChangeText={model.setAmount} keyboardType="decimal-pad" testID="fund-amount" />
            <Txt variant="caption" tone="secondary">{t('fund.currency.label', locale)}</Txt>
            <Choice options={CURRENCIES} value={s.currency} label={(c) => c} onChoose={(c) => void model.setCurrency(c)} testID="fund-currency" />
            <Txt variant="caption" tone="secondary">{t('fund.purse.label', locale)}</Txt>
            <Choice options={CURRENCIES} value={s.purse} label={(c) => t(`fund.purse.${c}`, locale)} onChoose={(c) => void model.setPurse(c)} testID="fund-purse" />
          </Card>
          {s.quote ? (
            <Card testID="fund-quote-card">
              <Txt variant="title2">{t('fund.quote.lands', locale, { credited: fmt({ minor: BigInt(s.quote.total.minor), currency: s.quote.total.currency }, locale) })}</Txt>
              <Txt tone="secondary">{t('fund.quote.rate', locale, { rate: s.quote.rate, version: s.quote.rateVersion ?? '—' })}</Txt>
              <Txt variant="caption" tone="secondary" testID="fund-countdown">{t('fund.quote.countdown', locale, { s: s.secondsLeft })}</Txt>
            </Card>
          ) : null}
          <Card>
            <Txt variant="caption" tone="secondary">{t('fund.method.label', locale)}</Txt>
            <Choice options={methodsFor(s.achEnabled)} value={s.method} label={(m) => t(`fund.method.${m}`, locale)} onChoose={model.setMethod} testID="fund-method" />
            {s.method === 'ach' ? <Banner tone="warning" body={t('fund.ach.notice', locale)} testID="fund-ach-notice" /> : null}
          </Card>
          <Button label={t('fund.autoReload.link', locale)} variant="tertiary" onPress={() => router.push('/fund/auto-reload')} testID="fund-auto-reload" />
        </>
      )}
    </Screen>
  );
}

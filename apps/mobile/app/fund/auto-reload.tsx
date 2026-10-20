// P07 auto-reload (T-0525): the purse's rule (threshold, target, saved payment method, on or off), the
// 24-hour rule in words, and when it last ran. While the wallet is off there is nothing to set.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { uuidv7, type Currency } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Badge, Banner, Button, Card, Screen, Skeleton, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale, type Locale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useTheme } from '../../src/theme.ts';
import { createAutoReloadModel, RELOAD_METHODS, type AutoReloadModel } from './auto-reload.model.ts';

const CURRENCIES: readonly Currency[] = ['USD', 'ILS'];

export function useAutoReloadModel(): AutoReloadModel {
  const api = useApi();
  return useMemo(() => createAutoReloadModel({ reload: api.reload, accounts: () => api.wallet.listAccounts(), newKey: uuidv7 }), [api]);
}

export default function AutoReloadScreen() {
  return <AutoReloadView model={useAutoReloadModel()} />;
}

const when = (iso: string, locale: Locale): string => new Date(iso).toLocaleString(locale === 'he' ? 'he-IL' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Row({ children }: { children: React.ReactNode }) {
  const th = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space[2] }}>{children}</View>;
}

export function AutoReloadView({ model }: { model: AutoReloadModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'off') {
    return (
      <Screen title={t('reload.title', locale)} testID="screen-auto-reload">
        <Banner tone="info" body={t('reload.off', locale)} testID="reload-off" />
      </Screen>
    );
  }
  if (s.mode === 'loading') {
    return (
      <Screen title={t('reload.title', locale)} testID="screen-auto-reload">
        <Skeleton />
      </Screen>
    );
  }

  const footer = (
    <View style={{ gap: 8 }}>
      <Button label={t('reload.save', locale)} onPress={() => void model.save()} loading={s.busy} disabled={!s.paymentMethodId} testID="reload-save" />
      {s.rule?.enabled ? <Button label={t('reload.turnOff', locale)} variant="secondary" onPress={() => void model.turnOff()} disabled={s.busy} testID="reload-turn-off" /> : null}
    </View>
  );

  return (
    <Screen title={t('reload.title', locale)} subtitle={t('reload.subtitle', locale)} testID="screen-auto-reload" footer={footer}>
      {s.needsStepUp ? <Banner tone="info" body={t('reload.stepUp', locale)} testID="reload-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="reload-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="reload-notice" /> : null}
      <Row>
        {CURRENCIES.map((c) => (
          <Button key={c} label={t(`fund.purse.${c}`, locale)} variant={c === s.purse ? 'primary' : 'secondary'} onPress={() => void model.setPurse(c)} testID={`reload-purse-${c}`} />
        ))}
      </Row>
      <Card testID="reload-rule">
        <Row>
          <Badge label={t(s.rule?.enabled ? 'reload.status.on' : 'reload.status.off', locale)} tone={s.rule?.enabled ? 'success' : 'neutral'} testID="reload-status" />
        </Row>
        <Txt tone="secondary">{t('reload.rule', locale)}</Txt>
        {s.rule?.lastAttemptAt ? <Txt variant="caption" tone="secondary" testID="reload-last">{t('reload.last', locale, { when: when(s.rule.lastAttemptAt, locale) })}</Txt> : null}
        {s.rule?.nextEligibleAt ? <Txt variant="caption" tone="secondary" testID="reload-next">{t('reload.next', locale, { when: when(s.rule.nextEligibleAt, locale) })}</Txt> : null}
      </Card>
      <Card>
        <TextField label={`${t('reload.threshold.label', locale)} (${s.purse})`} value={s.thresholdText} onChangeText={model.setThreshold} keyboardType="decimal-pad" testID="reload-threshold" />
        <TextField label={`${t('reload.target.label', locale)} (${s.purse})`} value={s.targetText} onChangeText={model.setTarget} keyboardType="decimal-pad" testID="reload-target" />
      </Card>
      <Card>
        <Txt variant="caption" tone="secondary">{t('reload.method.label', locale)}</Txt>
        <Row>
          {RELOAD_METHODS.map((m) => (
            <Button key={m} label={t(`fund.method.${m}`, locale)} variant={m === s.method ? 'primary' : 'secondary'} onPress={() => model.setMethod(m)} testID={`reload-method-${m}`} />
          ))}
        </Row>
        {s.savedMethods.length === 0 && !s.paymentMethodId ? (
          <Banner tone="warning" body={t('reload.method.none', locale)} testID="reload-no-method" />
        ) : (
          <Row>
            {s.savedMethods.map((pm) => (
              <Button key={pm.id} label={pm.label} variant={pm.id === s.paymentMethodId ? 'primary' : 'secondary'} onPress={() => model.setPaymentMethod(pm.id)} testID={`reload-pm-${pm.id}`} />
            ))}
          </Row>
        )}
      </Card>
    </Screen>
  );
}

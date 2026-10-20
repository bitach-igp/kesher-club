// M34 close account (T-0526): each purse's balance and where its refund goes, then "Refund … and close"
// (or "Close account" when there is nothing to refund), with a passkey. While refunds are on their way it
// shows them; a block says why. Reached by its link until Settings (M33) lists it.
import { useEffect, useMemo } from 'react';
import { fromWire, uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale, type CopyKey } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { amountsText, createCloseModel, fmt, phaseOf, refundPlan, type CloseModel } from './close.model.ts';

export function useCloseModel(): CloseModel {
  const api = useApi();
  return useMemo(() => createCloseModel({ closure: api.closure, newKey: uuidv7 }), [api]);
}

export default function CloseScreen() {
  return <CloseView model={useCloseModel()} />;
}

export function CloseView({ model }: { model: CloseModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  const c = s.closure;
  if (!c) {
    return (
      <Screen title={t('close.title', locale)} testID="screen-close">
        {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="close-error" /> : <Skeleton />}
      </Screen>
    );
  }

  const phase = phaseOf(c);
  const plan = refundPlan(c);
  const footer =
    phase === 'refund_first' ? (
      <Button label={t('close.refundAndClose', locale, { amounts: amountsText(plan, locale) })} variant="destructive" onPress={() => void model.close()} loading={s.busy} testID="close-refund" />
    ) : phase === 'empty' ? (
      <Button label={t('close.close', locale)} variant="destructive" onPress={() => void model.close()} loading={s.busy} testID="close-confirm" />
    ) : phase === 'refunding' ? (
      <Button label={t('close.check', locale)} variant="secondary" onPress={() => void model.load()} testID="close-check" />
    ) : undefined;

  return (
    <Screen title={t('close.title', locale)} subtitle={t('close.subtitle', locale)} testID="screen-close" {...(footer ? { footer } : {})}>
      {s.needsStepUp ? <Banner tone="info" body={t('close.stepUp', locale)} testID="close-stepup" /> : null}
      {s.notice ? <Banner tone="info" body={t(s.notice.key, locale, s.notice.vars)} testID="close-notice" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="close-error" /> : null}
      {phase === 'closed' ? <Banner tone="success" body={t('close.closed', locale)} testID="close-closed" /> : null}
      {phase === 'blocked' && c.blockedReason ? <Banner tone="warning" body={t(`close.blocked.${c.blockedReason}` as CopyKey, locale)} testID="close-blocked" /> : null}
      {phase === 'refunding' ? <Banner tone="info" body={t('close.refunding', locale, { amounts: amountsText(c.refunds.map((r) => fromWire(r.amount)), locale) })} testID="close-refunding" /> : null}

      {phase !== 'closed' ? (
        <Card testID="close-balances">
          {c.balances.map((b) => (
            <Txt key={b.currency} testID={`close-balance-${b.currency}`}>{t('close.balance', locale, { currency: b.currency, amount: fmt(fromWire(b.available), locale) })}</Txt>
          ))}
          {phase === 'refund_first' ? plan.map((m) => <Txt key={m.currency} tone="secondary" testID={`close-plan-${m.currency}`}>{t('close.refundTo', locale, { amount: fmt(m, locale) })}</Txt>) : null}
          {phase === 'empty' ? <Txt tone="secondary" testID="close-empty">{t('close.empty', locale)}</Txt> : null}
        </Card>
      ) : null}

      {c.refunds.length ? (
        <Card testID="close-refunds">
          {c.refunds.map((r) => (
            <Txt key={r.id} testID={`close-refund-${r.id}`}>{t(`close.refund.${r.state}`, locale, { amount: fmt(fromWire(r.amount), locale) })}</Txt>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

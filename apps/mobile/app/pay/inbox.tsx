// M18 request inbox: what the member owes (pay or decline) and what they asked for, then history.
// Notes are other members' text: shown as written.
import { useEffect } from 'react';
import { Badge, Banner, Button, Card, EmptyState, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useSession } from '../../src/session.ts';
import { usePayModel } from './index.tsx';
import { formatMoney, inboxView, partyIdOf, type PayModel } from './pay.model.ts';

export default function InboxScreen() {
  const session = useSession();
  return <InboxView model={usePayModel()} me={partyIdOf(session.accessToken()) ?? ''} />;
}

export function InboxView({ model, me }: { model: PayModel; me: string }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  if (s.mode === 'loading') {
    return (
      <Screen title={t('pay.inbox.title', locale)} testID="screen-pay-inbox">
        <Skeleton />
      </Screen>
    );
  }
  const v = inboxView(s.requests, me);
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale === 'he' ? 'he-IL' : 'en-US');
  return (
    <Screen title={t('pay.inbox.title', locale)} testID="screen-pay-inbox">
      {s.needsStepUp ? <Banner tone="info" body={t('pay.confirm.stepUp', locale)} testID="inbox-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="inbox-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="inbox-notice" /> : null}
      {s.requests.length === 0 ? <EmptyState title={t('pay.inbox.empty.title', locale)} body={t('pay.inbox.empty.body', locale)} /> : null}
      {v.owed.length ? (
        <Card testID="inbox-owed">
          <Txt variant="headline">{t('pay.inbox.owed', locale)}</Txt>
          {v.owed.map((r) => (
            <Card key={r.id} testID={`inbox-owed-${r.id}`}>
              <Txt variant="title2">{formatMoney(r.amount, locale)}</Txt>
              {r.note ? <Txt tone="secondary">{r.note}</Txt> : null}
              <Txt variant="caption" tone="secondary">
                {t('pay.inbox.expires', locale, { date: date(r.expiresAt) })}
              </Txt>
              <Button label={t('pay.inbox.pay', locale, { amount: formatMoney(r.amount, locale) })} onPress={() => void model.payRequest(r.id)} loading={s.busy} testID={`inbox-pay-${r.id}`} />
              <Button label={t('pay.inbox.decline', locale)} variant="tertiary" onPress={() => void model.declineRequest(r.id)} disabled={s.busy} testID={`inbox-decline-${r.id}`} />
            </Card>
          ))}
        </Card>
      ) : null}
      {v.asked.length ? (
        <Card testID="inbox-asked">
          <Txt variant="headline">{t('pay.inbox.asked', locale)}</Txt>
          {v.asked.map((r, i) => (
            <ListRow key={r.id} title={formatMoney(r.amount, locale)} {...(r.note ? { subtitle: r.note } : {})} trailing={t('pay.inbox.expires', locale, { date: date(r.expiresAt) })} last={i === v.asked.length - 1} />
          ))}
        </Card>
      ) : null}
      {v.history.length ? (
        <Card testID="inbox-history">
          {v.history.map((r, i) => (
            <ListRow key={r.id} title={formatMoney(r.amount, locale)} {...(r.note ? { subtitle: r.note } : {})} trailing={t(`pay.inbox.status.${r.status}`, locale)} last={i === v.history.length - 1} />
          ))}
          <Badge label={t('pay.inbox.paid', locale)} />
        </Card>
      ) : null}
    </Screen>
  );
}

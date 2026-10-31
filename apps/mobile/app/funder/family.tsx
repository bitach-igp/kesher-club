// P05 family dashboard (T-0535): a card per member the funder pays for, balance in dollars first with shekels one tap
// away, last spend and the membership's state, Add money; invited members with Send again; empty offers an invite.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { fmt } from './plans.model.ts';
import { createFamilyModel, statusKey, type FamilyModel } from './family.model.ts';

export default function FamilyScreen() {
  const api = useApi();
  const router = useRouter();
  const model = useMemo(() => createFamilyModel({ funder: api.funder, router }), [api, router]);
  return <FamilyView model={model} />;
}

export function FamilyView({ model }: { model: FamilyModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('family.title', locale)} testID="screen-family">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'error') {
    return (
      <Screen title={t('family.title', locale)} testID="screen-family-error" footer={<Button label={t('common.retry', locale)} onPress={() => void model.load()} testID="family-retry" />}>
        <Banner tone="danger" body={t(s.error ?? 'common.error.generic', locale)} />
      </Screen>
    );
  }
  if (s.mode === 'empty') {
    return (
      <Screen title={t('family.title', locale)} testID="screen-family-empty">
        <EmptyState title={t('family.empty.title', locale)} body={t('family.empty.body', locale)} action={<Button label={t('family.invite', locale)} onPress={model.inviteSomeone} testID="family-invite" />} />
      </Screen>
    );
  }
  const other = s.shown === 'USD' ? 'ILS' : 'USD';
  return (
    <Screen title={t('family.title', locale)} testID="screen-family" footer={<Button label={t('family.invite', locale)} variant="secondary" onPress={model.inviteSomeone} testID="family-invite" />}>
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="family-notice" /> : null}
      <Button label={t('family.showIn', locale, { currency: other })} variant="tertiary" onPress={model.toggleCurrency} testID="family-currency" />
      {s.members.map((m) => {
        const status = statusKey(m);
        return (
          <Card key={m.partyId} testID={`family-member-${m.partyId}`}>
            {/* The member's own display name, shown as written. */}
            <Txt variant="headline">{m.name}</Txt>
            <Txt variant="title1" tabular testID={`family-balance-${m.partyId}`}>
              {fmt(m.balances[s.shown], locale)}
            </Txt>
            {status ? <Txt tone="secondary">{t(status, locale)}</Txt> : null}
            <Txt tone="secondary">{m.lastSpend ? t('family.lastSpend', locale, { amount: fmt(m.lastSpend.amount, locale), date: new Date(m.lastSpend.at).toLocaleDateString(locale === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'short' }) }) : t('family.noSpend', locale)}</Txt>
            <Button label={t('family.addMoney', locale)} onPress={() => model.addMoney(m.partyId)} testID={`family-add-${m.partyId}`} />
            <Button label={t('family.open', locale)} variant="tertiary" onPress={() => model.open(m.partyId)} testID={`family-open-${m.partyId}`} />
          </Card>
        );
      })}
      {s.invited.map((i) => (
        <Card key={i.inviteId} testID={`family-invited-${i.inviteId}`}>
          {/* The name the funder typed, shown as written. */}
          <Txt variant="headline">{i.name}</Txt>
          <Txt tone="secondary">{t('family.inviteSent', locale)}</Txt>
          <Button label={t('funder.invite.resend', locale)} variant="tertiary" onPress={() => void model.resend(i.inviteId)} disabled={s.busy} testID={`family-resend-${i.inviteId}`} />
        </Card>
      ))}
    </Screen>
  );
}

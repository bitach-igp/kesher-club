// M04 for a funder's invite (T-0309): who pays, the plan and its price, Accept. Read signed in; a signed-out member
// signs in or up first and comes back here. Extra states: expired (or cancelled) and already accepted.
import { format } from '@kesher/domain';
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { intlLocale, t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useSession } from '../../src/session.ts';
import { createJoinModel, type JoinModel } from './join.model.ts';

export default function JoinScreen() {
  const api = useApi();
  const router = useRouter();
  const params = useParams();
  const session = useSession();
  const model = useMemo(() => createJoinModel({ api: api.funder, router, token: params['token'], signedIn: () => session.accessToken() !== undefined }), [api, router, params, session]);
  return <JoinView model={model} />;
}

export function JoinView({ model }: { model: JoinModel }) {
  const router = useRouter();
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('join.title', locale)} testID="screen-join">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'signin') {
    return (
      <Screen title={t('join.title', locale)} testID="screen-join-signin">
        <EmptyState title={t('join.signin.title', locale)} body={t('join.signin.body', locale)} action={<Button label={t('invite.signIn', locale)} onPress={model.signIn} testID="join-signin" />} />
      </Screen>
    );
  }
  if (s.mode === 'expired' || s.mode === 'accepted' || s.mode === 'error') {
    const funder = s.preview?.funderName ?? '';
    return (
      <Screen title={t('join.title', locale)} testID={`screen-join-${s.mode}`}>
        {s.mode === 'error' ? (
          <Banner tone="danger" body={t(s.error ?? 'join.invalid', locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} />
        ) : (
          <EmptyState title={t(`join.${s.mode}.title`, locale)} body={t(`join.${s.mode}.body`, locale, { funder })} action={<Button label={t('common.continue', locale)} variant="secondary" onPress={() => router.replace('/')} />} />
        )}
      </Screen>
    );
  }
  const p = s.preview;
  return (
    <Screen
      title={t('join.title', locale)}
      subtitle={t('join.subtitle', locale, { funder: p?.funderName ?? '' })}
      testID="screen-join-open"
      footer={<Button label={t(s.busy ? 'invite.accepting' : 'join.accept', locale)} onPress={() => void model.accept()} loading={s.busy} testID="join-accept" />}
    >
      {s.error ? <Banner tone="danger" body={t(s.error, locale, { funder: p?.funderName ?? '' })} testID="join-error" /> : null}
      {p ? (
        <Card testID="join-plan">
          {/* The funder's display name and the plan's name are other people's text, shown as written. */}
          <Txt variant="headline">{p.planName}</Txt>
          <Txt>{t('funder.plan.price', locale, { price: format(p.price, intlLocale(locale)), months: p.termMonths })}</Txt>
          <Txt tone="secondary">{t('join.paidBy', locale, { funder: p.funderName })}</Txt>
        </Card>
      ) : null}
    </Screen>
  );
}

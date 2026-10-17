// M04 invite accept: funder and institution names, plan, accept. Edge states: expired, already accepted.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { createInviteModel, type InviteModel } from './invite.model.ts';

export default function InviteScreen() {
  const api = useApi();
  const router = useRouter();
  const params = useParams();
  const model = useMemo(() => createInviteModel({ api: api.invites, router, token: params['token'] }), [api, router, params]);
  return <InviteView model={model} />;
}

export function InviteView({ model }: { model: InviteModel }) {
  const router = useRouter();
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  const funder = s.preview?.funderName ?? '';
  if (s.mode === 'loading') {
    return (
      <Screen title={t('invite.title', locale)} testID="screen-invite">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'expired' || s.mode === 'accepted' || s.mode === 'error') {
    const key = s.mode === 'expired' ? 'expired' : s.mode === 'accepted' ? 'accepted' : undefined;
    return (
      <Screen title={t('invite.title', locale)} testID={`screen-invite-${s.mode}`}>
        {key ? (
          <EmptyState title={t(`invite.${key}.title`, locale)} body={t(`invite.${key}.body`, locale, { funder })} action={<Button label={t('invite.signIn', locale)} variant="secondary" onPress={() => router.replace('/sign-in')} />} />
        ) : (
          <Banner tone="danger" body={t(s.error ?? 'invite.invalid', locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} />
        )}
      </Screen>
    );
  }
  return (
    <Screen
      title={t('invite.title', locale)}
      subtitle={t('invite.subtitle', locale, { funder })}
      testID="screen-invite-open"
      footer={<Button label={t(s.busy ? 'invite.accepting' : 'invite.accept', locale)} onPress={() => void model.accept()} loading={s.busy} testID="invite-accept" />}
    >
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
      <Card>
        {s.preview?.institutionName ? <Txt variant="headline">{t('invite.institution', locale, { institution: s.preview.institutionName })}</Txt> : null}
        <Txt variant="body">{t('invite.plan', locale, { plan: s.preview?.planName ?? '' })}</Txt>
      </Card>
    </Screen>
  );
}

// M04 invite accept: institution, roster name and programme, accept. Edge states: expired, already accepted.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useSession } from '../../src/session.ts';
import { createInviteModel, type InviteModel } from './invite.model.ts';

export default function InviteScreen() {
  const api = useApi();
  const router = useRouter();
  const params = useParams();
  const session = useSession();
  const model = useMemo(() => createInviteModel({ api: api.invites, router, token: params['token'], signedIn: () => session.accessToken() !== undefined }), [api, router, params, session]);
  return <InviteView model={model} />;
}

export function InviteView({ model }: { model: InviteModel }) {
  const router = useRouter();
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  const institution = s.preview?.institutionName ?? '';
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
          <EmptyState title={t(`invite.${key}.title`, locale)} body={t(`invite.${key}.body`, locale, { institution })} action={<Button label={t('invite.signIn', locale)} variant="secondary" onPress={() => router.replace('/sign-in')} />} />
        ) : (
          <Banner tone="danger" body={t(s.error ?? 'invite.invalid', locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} />
        )}
      </Screen>
    );
  }
  return (
    <Screen
      title={t('invite.title', locale)}
      subtitle={t('invite.subtitle', locale, { institution })}
      testID="screen-invite-open"
      footer={<Button label={t(s.busy ? 'invite.accepting' : 'invite.accept', locale)} onPress={() => void model.accept()} loading={s.busy} testID="invite-accept" />}
    >
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
      <Card>
        <Txt variant="headline">{t('invite.member', locale, { name: s.preview?.memberName ?? '' })}</Txt>
        {s.preview?.programme ? <Txt variant="body">{t('invite.programme', locale, { programme: s.preview.programme })}</Txt> : null}
      </Card>
    </Screen>
  );
}

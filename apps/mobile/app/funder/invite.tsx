// P04 invite your child (T-0308): who, by text message or email, for the plan chosen in P01–P03; then the invites
// sent, with their state, and Send again or Cancel on an open one. Nothing is charged until the member accepts.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams } from '../../src/navigation.ts';
import { useTheme } from '../../src/theme.ts';
import { createFunderInviteModel, stateKey, type ContactKind, type FunderInviteModel } from './invite.model.ts';

const KINDS: readonly ContactKind[] = ['phone', 'email'];

export default function FunderInviteScreen() {
  const api = useApi();
  const params = useParams();
  const model = useMemo(() => createFunderInviteModel({ funder: api.funder, newKey: uuidv7 }, params['plan'] ?? ''), [api, params]);
  return <FunderInviteView model={model} />;
}

export function FunderInviteView({ model }: { model: FunderInviteModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const th = useTheme();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading') {
    return (
      <Screen title={t('funder.invite.title', locale)} testID="screen-funder-invite">
        <Skeleton />
      </Screen>
    );
  }
  const problem = (key: 'funder.invite.name.invalid' | 'funder.invite.phone.invalid' | 'funder.invite.email.invalid') => (s.problems.includes(key) ? { error: t(key, locale) } : {});
  return (
    <Screen title={t('funder.invite.title', locale)} subtitle={t('funder.invite.subtitle', locale)} testID="screen-funder-invite" footer={<Button label={t('funder.invite.send', locale)} onPress={() => void model.send()} disabled={s.busy} testID="funder-invite-send" />}>
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="funder-invite-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="funder-invite-notice" /> : null}
      <TextField label={t('funder.invite.name', locale)} value={s.form.memberName} onChangeText={(memberName) => model.setForm({ memberName })} autoComplete="name" testID="funder-invite-name" {...problem('funder.invite.name.invalid')} />
      <View style={{ flexDirection: 'row', gap: th.space[2] }}>
        {KINDS.map((k) => (
          <Button key={k} label={t(`funder.invite.kind.${k}`, locale)} variant={k === s.form.kind ? 'primary' : 'secondary'} onPress={() => model.setForm({ kind: k })} testID={`funder-invite-kind-${k}`} />
        ))}
      </View>
      {s.form.kind === 'phone' ? (
        <TextField label={t('funder.invite.phone', locale)} value={s.form.contact} onChangeText={(contact) => model.setForm({ contact })} keyboardType="phone-pad" autoComplete="tel" testID="funder-invite-phone" {...problem('funder.invite.phone.invalid')} />
      ) : (
        <TextField label={t('funder.invite.email', locale)} value={s.form.contact} onChangeText={(contact) => model.setForm({ contact })} keyboardType="email-address" autoCapitalize="none" autoComplete="email" testID="funder-invite-email" {...problem('funder.invite.email.invalid')} />
      )}
      <Card testID="funder-invite-list">
        <Txt variant="headline">{t('funder.invite.list', locale)}</Txt>
        {s.sent.length === 0 ? <Txt tone="secondary">{t('funder.invite.none', locale)}</Txt> : null}
        {s.sent.map((i, n) => (
          <View key={i.id}>
            {/* The funder's own entry, as they typed it; the contact comes back masked. */}
            <ListRow title={`${i.memberName} · ${i.contact}`} subtitle={t(stateKey(i), locale)} last={n === s.sent.length - 1 && i.status !== 'open'} testID={`funder-invite-${i.id}`} />
            {i.status === 'open' ? (
              <View style={{ flexDirection: 'row', gap: th.space[2] }}>
                <Button label={t('funder.invite.resend', locale)} variant="tertiary" onPress={() => void model.resend(i.id)} disabled={s.busy} testID={`funder-invite-resend-${i.id}`} />
                <Button label={t('funder.invite.cancel', locale)} variant="tertiary" onPress={() => void model.cancel(i.id)} disabled={s.busy} testID={`funder-invite-cancel-${i.id}`} />
              </View>
            ) : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}

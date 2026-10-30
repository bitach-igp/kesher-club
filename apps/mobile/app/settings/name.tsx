// "Your name" (T-0532): the name others see when they pay the member. See name.model.ts.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, Screen, Skeleton, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { createNameModel, preview, type NameModel } from './name.model.ts';

export default function NameScreen() {
  const api = useApi();
  const model = useMemo(() => createNameModel({ displayName: api.displayName }), [api]);
  return <NameView model={model} />;
}

export function NameView({ model }: { model: NameModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  const shown = preview(s.firstName, s.lastName);
  return (
    <Screen title={t('name.title', locale)} subtitle={t('name.subtitle', locale)} testID="screen-name">
      {s.status === 'loading' || s.status === 'idle' ? <Skeleton /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="name-notice" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} testID="name-error" /> : null}
      {s.status === 'ready' ? (
        <Card>
          {/* Member text, shown as written. */}
          <Txt tone="secondary" testID="name-current">
            {s.current ? t('name.current', locale, { name: s.current }) : t('name.notSet', locale)}
          </Txt>
          <TextField label={t('name.first', locale)} value={s.firstName} onChangeText={model.setFirstName} autoComplete="given-name" textContentType="givenName" maxLength={40} {...(s.problems.includes('firstName') ? { error: t('name.problem.firstName', locale) } : {})} testID="name-first" />
          <TextField label={t('name.last', locale)} helper={t('name.lastHelper', locale)} value={s.lastName} onChangeText={model.setLastName} autoComplete="family-name" textContentType="familyName" maxLength={80} {...(s.problems.includes('lastName') ? { error: t('name.problem.lastName', locale) } : {})} testID="name-last" />
          {shown ? (
            <Txt tone="secondary" testID="name-preview">
              {t('name.preview', locale, { name: shown })}
            </Txt>
          ) : null}
          <Button label={t('name.save', locale)} onPress={() => void model.save()} disabled={s.saving} testID="name-save" />
        </Card>
      ) : null}
    </Screen>
  );
}

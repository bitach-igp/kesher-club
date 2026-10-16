// Assistants: every agent grant with client, scopes and last use; one-tap revoke (T-1006).
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { useApi } from '../../../src/api.ts';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Txt } from '../../../src/components/index.ts';
import { useNow } from '../../../src/clock.ts';
import { t, useLocale } from '../../../src/i18n.ts';
import { useStore } from '../../../src/model.ts';
import { useTheme } from '../../../src/theme.ts';
import { createGrantsModel, relativeTime, scopeCopy, type GrantsModel } from './grants.model.ts';

export default function AssistantsScreen() {
  const api = useApi();
  const model = useMemo(() => createGrantsModel({ grants: api.grants }), [api]);
  return <AssistantsView model={model} />;
}

export function AssistantsView({ model }: { model: GrantsModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const now = useNow();
  const th = useTheme();
  useEffect(() => void model.load(), [model]);
  return (
    <Screen title={t('grants.title', locale)} subtitle={t('grants.subtitle', locale)} testID="screen-assistants">
      {s.status === 'loading' || s.status === 'idle' ? <Skeleton /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="grants-notice" /> : null}
      {s.error ? <Banner tone={s.error === 'grants.rateLimited' ? 'warning' : 'danger'} body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} testID="grants-error" /> : null}
      {s.status === 'ready' && s.grants.length === 0 ? <EmptyState title={t('grants.empty.title', locale)} body={t('grants.empty.body', locale)} /> : null}
      {s.grants.map((g) => {
        const used = relativeTime(g.lastUsedAt, now());
        const connected = relativeTime(g.createdAt, now());
        return (
          <Card key={g.id} testID={`grant-${g.id}`}>
            {/* Client name is text supplied by the agent's metadata: rendered as data only. */}
            <Txt variant="headline">{g.clientName}</Txt>
            <Txt variant="caption" tone="secondary">
              {g.lastUsedAt ? t('grants.lastUsed', locale, { when: t(used.key, locale, used.vars) }) : t('grants.neverUsed', locale)} · {t('grants.connected', locale, { when: t(connected.key, locale, connected.vars) })}
            </Txt>
            <View style={{ gap: th.space[1] }}>
              <Txt variant="caption" tone="secondary">
                {t('grants.can', locale)}
              </Txt>
              {g.scopes.map((scope) => {
                const c = scopeCopy(scope);
                return (
                  <Txt key={scope} variant="body">
                    {`• ${t(c.key, locale, c.vars)}`}
                  </Txt>
                );
              })}
            </View>
            <Button label={t(g.revoking ? 'grants.revoking' : 'grants.revoke', locale)} variant="destructive" onPress={() => void model.revoke(g.id)} loading={g.revoking} testID={`revoke-${g.id}`} />
          </Card>
        );
      })}
    </Screen>
  );
}

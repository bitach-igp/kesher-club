// "Connect an assistant" (T-1017): who is asking, each scope in plain words grouped by what it allows, and
// Connect (passkey) or Not now. The assistant's name and home page are its own words: shown as text, and the
// home page is not a link. See connect.model.ts.
import { useEffect, useMemo } from 'react';
import { Linking, Platform } from 'react-native';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams } from '../../src/navigation.ts';
import { createConnectModel, groups, SCOPE_WORDS, type ConnectModel } from './connect.model.ts';

export default function ConnectScreen() {
  const api = useApi();
  const id = useParams()['id'] ?? '';
  // The decision goes back to the assistant in this same page on the web, as OAuth expects; a new tab would leave
  // the member looking at the consent screen. On a phone, the system opens the assistant's link.
  const open = (url: string) => (Platform.OS === 'web' ? globalThis.location.assign(url) : void Linking.openURL(url));
  const model = useMemo(() => createConnectModel({ agent: api.agent, id, open }), [api, id]);
  return <ConnectView model={model} />;
}

export function ConnectView({ model }: { model: ConnectModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  const r = s.request;
  return (
    <Screen
      title={t('connect.title', locale)}
      testID="screen-connect"
      footer={
        s.mode === 'ready' ? (
          <>
            <Button label={t('connect.connect', locale)} onPress={() => void model.connect()} loading={s.busy} testID="connect-approve" />
            <Button label={t('connect.decline', locale)} variant="tertiary" onPress={() => void model.decline()} disabled={s.busy} testID="connect-decline" />
          </>
        ) : undefined
      }
    >
      {s.mode === 'loading' ? <Skeleton /> : null}
      {s.mode === 'gone' ? <Banner tone="warning" body={t('connect.gone', locale)} testID="connect-gone" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="connect-error" /> : null}
      {s.needsStepUp ? <Banner tone="info" body={t('connect.stepUp', locale)} testID="connect-stepup" /> : null}
      {s.mode === 'ready' && r ? (
        <>
          <Card testID="connect-who">
            {/* The assistant's own words, shown as text. */}
            <Txt variant="headline">{t('connect.asks', locale, { name: r.client.name })}</Txt>
            {r.client.uri ? (
              <Txt tone="secondary" testID="connect-uri">
                {r.client.uri}
              </Txt>
            ) : null}
          </Card>
          {groups(r).map((g) => (
            <Card key={g.tier} testID={`connect-tier-${g.tier}`}>
              <Txt variant="caption" tone="secondary">
                {t(g.label, locale)}
              </Txt>
              {g.tier === 'T2' ? <Txt tone="secondary">{t('connect.proposeHelper', locale)}</Txt> : null}
              {g.scopes.map((scope, i) => {
                const words = SCOPE_WORDS[scope];
                return (
                  <ListRow
                    key={scope}
                    title={words ? t(words, locale) : scope}
                    {...(s.kept.includes(scope) ? { trailing: '✓' } : {})}
                    onPress={() => model.toggle(scope)}
                    accessibilityLabel={words ? t(words, locale) : scope}
                    testID={`connect-scope-${scope}`}
                    last={i === g.scopes.length - 1}
                  />
                );
              })}
            </Card>
          ))}
          <Txt tone="secondary">{t('connect.revokeLater', locale)}</Txt>
        </>
      ) : null}
    </Screen>
  );
}

// The terms at sign-up and at re-accept (T-0062). Each document: title, a short summary, a link to the web page,
// and its own switch, off until the member turns it on. One button at the bottom, enabled when every switch is on.
// No fixed heights: the text grows with Dynamic Type, and the layout uses start/end only, so it mirrors in Hebrew.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, Screen, Skeleton, Toggle, Txt } from '../../src/components/index.ts';
import { createConsentModel, legalBuild, useConsentGate, type ConsentModel } from '../../src/consent.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useOpener } from '../../src/linking.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useSession } from '../../src/session.ts';

/** Route component: `?returnTo=` is where the member was going. */
export default function ConsentScreen() {
  const api = useApi();
  const router = useRouter();
  const opener = useOpener();
  const locale = useLocale();
  const params = useParams();
  const gate = useConsentGate();
  const session = useSession();
  const returnTo = params['returnTo'];
  const model = useMemo(() => createConsentModel({ legal: api.legal, router, gate, locale, ...legalBuild(), returnTo, openURL: (url) => opener.openURL(url), signOut: () => session.signOut() }), [api, router, gate, locale, returnTo, opener, session]);
  return <ConsentView model={model} />;
}

export function ConsentView({ model }: { model: ConsentModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  if (s.mode === 'loading' || s.mode === 'done') {
    return (
      <Screen title={t('consent.title', locale)} testID="screen-consent">
        <Skeleton />
      </Screen>
    );
  }
  const signOut = <Button label={t('consent.signOut', locale)} variant="tertiary" onPress={model.signOut} testID="consent-sign-out" />;
  if (s.mode === 'error') {
    return (
      <Screen title={t('consent.title', locale)} testID="screen-consent-error" footer={signOut}>
        {s.error ? <Banner tone="danger" body={t(s.error, locale)} {...(s.signedOut ? {} : { action: { label: t('common.retry', locale), onPress: () => void model.load() } })} testID="consent-error" /> : null}
      </Screen>
    );
  }
  return (
    <Screen
      title={t('consent.title', locale)}
      subtitle={t('consent.subtitle', locale)}
      testID="screen-consent"
      footer={
        <>
          <Button label={t(s.busy ? 'consent.saving' : 'consent.continue', locale)} onPress={() => void model.submit()} disabled={!model.canContinue()} loading={s.busy} testID="consent-continue" />
          {signOut}
        </>
      }
    >
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="consent-error" /> : null}
      {s.items.map((i) => (
        <Card key={i.docKey} testID={`consent-doc-${i.docKey}`}>
          <Txt variant="headline">{i.title}</Txt>
          <Txt variant="caption" tone="secondary">
            {t(`consent.reason.${i.reason}`, locale)}
          </Txt>
          <Txt>{i.summary}</Txt>
          {/* The full text, in the app: accepting never depends on the web page. Published by the legal service, shown as written. */}
          <Txt tone="secondary" testID={`consent-body-${i.docKey}`}>
            {i.body}
          </Txt>
          {i.url ? <Button label={t('consent.web', locale)} variant="tertiary" onPress={() => void model.open(i.docKey)} testID={`consent-web-${i.docKey}`} /> : null}
          <Toggle label={t('consent.accept', locale, { title: i.title })} value={i.accepted} onChange={(v) => model.set(i.docKey, v)} testID={`consent-accept-${i.docKey}`} />
        </Card>
      ))}
      {!model.canContinue() && !s.busy ? <Txt tone="secondary">{t('consent.remaining', locale)}</Txt> : null}
    </Screen>
  );
}

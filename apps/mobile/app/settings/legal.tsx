// Settings, "Legal" (T-0062): the documents in force and the versions the member accepted. Read-only. See legal.model.ts.
import { useEffect, useMemo } from 'react';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { legalBuild } from '../../src/consent.ts';
import { intlLocale, t, useLocale } from '../../src/i18n.ts';
import { useOpener } from '../../src/linking.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { createLegalModel, type LegalModel } from './legal.model.ts';

export default function LegalScreen() {
  const api = useApi();
  const router = useRouter();
  const opener = useOpener();
  const locale = useLocale();
  const model = useMemo(() => createLegalModel({ legal: api.legal, router, locale, webBaseUrl: legalBuild().webBaseUrl, openURL: (url) => opener.openURL(url) }), [api, router, locale, opener]);
  return <LegalView model={model} />;
}

export function LegalView({ model }: { model: LegalModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  const day = (iso: string) => new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
  const anyPending = s.rows.some((r) => r.pending);
  return (
    <Screen title={t('legal.title', locale)} subtitle={t('legal.subtitle', locale)} testID="screen-legal">
      {s.status === 'loading' ? <Skeleton /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} action={{ label: t('common.retry', locale), onPress: () => void model.load() }} testID="legal-error" /> : null}
      {s.status === 'ready' && s.rows.length === 0 ? <Txt tone="secondary">{t('legal.empty', locale)}</Txt> : null}
      {anyPending ? <Banner tone="warning" body={t('legal.pending', locale)} action={{ label: t('legal.review', locale), onPress: model.review }} testID="legal-pending" /> : null}
      {s.rows.map((r) => (
        <Card key={r.docKey} testID={`legal-doc-${r.docKey}`}>
          <Txt variant="headline">{r.title}</Txt>
          <Txt variant="caption" tone="secondary">
            {t('legal.version', locale, { version: r.version })}
          </Txt>
          <Txt tone="secondary" testID={`legal-status-${r.docKey}`}>
            {r.acceptedVersion !== undefined && r.acceptedAt ? t('legal.accepted', locale, { version: r.acceptedVersion, date: day(r.acceptedAt) }) : t('legal.notAccepted', locale)}
          </Txt>
          <Button label={t(s.open === r.docKey ? 'legal.hide' : 'legal.read', locale)} variant="secondary" onPress={() => model.toggleText(r.docKey)} testID={`legal-toggle-${r.docKey}`} />
          {/* The text is ours (published by the legal service), shown as written. */}
          {s.open === r.docKey ? <Txt testID={`legal-body-${r.docKey}`}>{r.body}</Txt> : null}
          {r.url ? <Button label={t('legal.web', locale)} variant="tertiary" onPress={() => void model.openWeb(r.docKey)} testID={`legal-web-${r.docKey}`} /> : null}
        </Card>
      ))}
    </Screen>
  );
}

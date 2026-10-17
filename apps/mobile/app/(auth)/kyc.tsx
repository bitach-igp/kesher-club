// M06 identity verification: start, pending, manual review, rejected with reasons and retry, approved.
// The capture itself runs in the card partner's SDK with the one-time client token; nothing from it
// is shown or stored here.
import { useEffect, useMemo, type ReactElement } from 'react';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Banner, Button, Card, EmptyState, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { createKycModel, type KycModel } from './kyc.model.ts';

export function useKycModel(): KycModel {
  const api = useApi();
  const router = useRouter();
  return useMemo(() => createKycModel({ kyc: api.kyc, router, newKey: uuidv7 }), [api, router]);
}

export default function KycScreen() {
  return <KycView model={useKycModel()} />;
}

export function KycView({ model }: { model: KycModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  const retry = { label: t('common.retry', locale), onPress: () => void model.load() };

  const footerFor = (mode: typeof s.mode): { footer?: ReactElement } => {
    if (mode === 'none') return { footer: <Button label={t('kyc.start', locale)} onPress={() => void model.start()} loading={s.busy} testID="kyc-start" /> };
    if (mode === 'rejected') return { footer: <Button label={t('kyc.retry', locale)} onPress={() => void model.retry()} loading={s.busy} testID="kyc-retry" /> };
    if (mode === 'approved') return { footer: <Button label={t('kyc.continue', locale)} onPress={model.continueToCard} testID="kyc-continue" /> };
    if (mode === 'pending' || mode === 'review') return { footer: <Button label={t('kyc.refresh', locale)} variant="tertiary" onPress={() => void model.refresh()} testID="kyc-refresh" /> };
    return {};
  };

  return (
    <Screen
      title={t('kyc.title', locale)}
      {...(s.mode === 'none' ? { subtitle: t('kyc.subtitle', locale) } : {})}
      testID="screen-kyc"
      {...footerFor(s.mode)}
    >
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
      {s.mode === 'loading' ? <Skeleton /> : null}
      {s.mode === 'error' ? <Banner tone="warning" body={t('common.error.generic', locale)} action={retry} /> : null}
      {s.mode === 'pending' ? <EmptyState title={t('kyc.pending.title', locale)} body={t('kyc.pending.body', locale)} /> : null}
      {s.mode === 'review' ? <EmptyState title={t('kyc.review.title', locale)} body={t('kyc.review.body', locale)} /> : null}
      {s.mode === 'approved' ? <EmptyState title={t('kyc.approved.title', locale)} body={t('kyc.approved.body', locale)} /> : null}
      {s.mode === 'rejected' ? (
        <>
          <Banner tone="danger" title={t('kyc.rejected.title', locale)} body={t('kyc.rejected.body', locale)} testID="kyc-rejected" />
          <Card>
            {s.reasons.map((r, i) => (
              <ListRow key={`${r.key}-${i}`} title={t(r.key, locale, r.vars)} last={i === s.reasons.length - 1} />
            ))}
          </Card>
        </>
      ) : null}
      {s.mode === 'none' ? <Txt tone="secondary">{t('kyc.subtitle', locale)}</Txt> : null}
    </Screen>
  );
}

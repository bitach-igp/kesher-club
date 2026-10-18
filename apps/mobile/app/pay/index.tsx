// M12 pay home: the available balance, send, request, split, scan and my code, and how many requests
// wait for the member. Each pay screen builds its own model; the flow travels in route params.
import { useEffect, useMemo } from 'react';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { useNow } from '../../src/clock.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { useDevice } from '../../src/device.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams, useRouter } from '../../src/navigation.ts';
import { useSession } from '../../src/session.ts';
import { available, createPayModel, formatMoney, inboxView, partyIdOf, type PayModel } from './pay.model.ts';

/** One model per screen, seeded from the URL (`to`, `amount`, `currency`, `note`). */
export function usePayModel(): PayModel {
  const api = useApi();
  const router = useRouter();
  const device = useDevice();
  const session = useSession();
  const locale = useLocale();
  const now = useNow();
  const params = useParams();
  return useMemo(
    () =>
      createPayModel(
        { pay: api.pay, router, newKey: uuidv7, now, me: partyIdOf(session.accessToken()) ?? '', camera: device.camera, contacts: device.contacts, locale },
        { ...(params['to'] ? { recipient: params['to'] } : {}), ...(params['amount'] ? { amountText: params['amount'] } : {}), ...(params['note'] ? { note: params['note'] } : {}), ...(params['currency'] === 'USD' || params['currency'] === 'ILS' ? { currency: params['currency'] } : {}) },
      ),
    [api, router, device, session, locale, now, params],
  );
}

export default function PayHomeScreen() {
  const session = useSession();
  return <PayHomeView model={usePayModel()} me={partyIdOf(session.accessToken()) ?? ''} />;
}

export function PayHomeView({ model, me }: { model: PayModel; me: string }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => void model.load(), [model]);
  const owed = inboxView(s.requests, me).owed.length;
  if (s.mode === 'loading') {
    return (
      <Screen title={t('pay.title', locale)} testID="screen-pay">
        <Skeleton />
      </Screen>
    );
  }
  return (
    <Screen title={t('pay.title', locale)} testID="screen-pay" footer={<Button label={t('pay.home.send', locale)} onPress={() => router.push('/pay/recipient')} testID="pay-send" />}>
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="pay-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="pay-notice" /> : null}
      <Card testID="pay-balance">
        <Txt variant="caption" tone="secondary">
          {t('pay.home.balance', locale)}
        </Txt>
        {(['ILS', 'USD'] as const).map((c) => (
          <Txt key={c} variant="title2">
            {formatMoney(available(s.accounts, c), locale)}
          </Txt>
        ))}
      </Card>
      <Card>
        <ListRow title={t('pay.home.request', locale)} onPress={() => router.push('/pay/request')} testID="pay-request" />
        <ListRow title={t('pay.home.split', locale)} onPress={() => router.push('/pay/split')} testID="pay-split" />
        <ListRow title={t('pay.home.scan', locale)} onPress={() => void model.scan()} testID="pay-scan" />
        <ListRow title={t('pay.home.myCode', locale)} onPress={() => router.push('/pay/qr')} testID="pay-qr" />
        <ListRow title={t('pay.home.inbox', locale)} {...(owed ? { trailing: t('pay.home.inboxOwed', locale, { n: owed }) } : {})} onPress={() => router.push('/pay/inbox')} testID="pay-inbox" last />
      </Card>
    </Screen>
  );
}

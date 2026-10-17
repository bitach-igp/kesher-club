// M20 card home: status, last four digits, wallets, freeze or unfreeze, lost or stolen, controls,
// details (through the processor's component) and physical ordering or activation. Nothing on this
// screen is card data.
import { useEffect, useMemo } from 'react';
import { uuidv7 } from '@kesher/domain';
import { useApi } from '../../src/api.ts';
import { Badge, Banner, Button, Card, EmptyState, ListRow, Screen, Skeleton, Txt } from '../../src/components/index.ts';
import { useDevice } from '../../src/device.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { createCardModel, shippingView, statusBanner, type CardModel } from './card.model.ts';

export function useCardModel(): CardModel {
  const api = useApi();
  const router = useRouter();
  const device = useDevice();
  return useMemo(() => createCardModel({ cards: api.cards, router, newKey: uuidv7, deviceId: () => `${device.info.platform}:${device.info.osVersion}` }), [api, router, device]);
}

export default function CardHomeScreen() {
  return <CardHomeView model={useCardModel()} />;
}

export function CardHomeView({ model }: { model: CardModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);
  const card = model.selected();
  const banner = card ? statusBanner(card) : undefined;
  const shipping = card ? shippingView(card) : undefined;

  if (s.mode === 'loading') {
    return (
      <Screen title={t('card.title', locale)} testID="screen-card">
        <Skeleton />
      </Screen>
    );
  }
  if (s.mode === 'none' || !card) {
    return (
      <Screen title={t('card.title', locale)} testID="screen-card-none" footer={<Button label={t('card.none.action', locale)} onPress={model.goVerify} testID="card-verify" />}>
        {s.notice ? <Banner tone="success" body={t(s.notice, locale)} /> : null}
        <EmptyState title={t('card.none.title', locale)} body={t('card.none.body', locale)} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t('card.title', locale)}
      subtitle={`${t(`card.type.${card.type}`, locale)} · ${t('card.ending', locale, { last4: card.last4 })}`}
      testID="screen-card"
      footer={
        card.status === 'frozen' ? (
          <Button label={t('card.unfreeze', locale)} onPress={() => void model.unfreeze()} loading={s.busy} testID="card-unfreeze" />
        ) : card.status === 'active' ? (
          <Button label={t('card.freeze', locale)} variant="secondary" onPress={() => void model.freeze()} loading={s.busy} testID="card-freeze" />
        ) : undefined
      }
    >
      {s.needsStepUp ? <Banner tone="info" body={t('card.stepUp', locale)} testID="card-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} /> : null}
      {banner ? <Banner tone={banner.tone} body={t(banner.key, locale)} testID={`card-banner-${card.status}`} /> : null}
      <Card>
        <ListRow title={t(`card.status.${card.status}`, locale)} trailing={card.last4} />
        {shipping?.shipped && !shipping.activated ? <ListRow title={t('card.physical.ordered', locale)} {...(shipping.trackingUrl ? { subtitle: shipping.trackingUrl } : {})} /> : null}
        {shipping && !shipping.activated ? <ListRow title={t('card.activate.title', locale)} onPress={() => model.select(card.id)} accessibilityHint="/card/activate" /> : null}
        <ListRow title={t('card.controls', locale)} onPress={() => model.select(card.id)} accessibilityHint="/card/controls" />
        <ListRow title={t('card.details', locale)} onPress={() => void model.showDetails()} />
        <ListRow title={t('card.lost', locale)} onPress={() => model.select(card.id)} accessibilityHint="/card/lost" last />
      </Card>
      <Txt variant="display">{t('card.tokens.title', locale)}</Txt>
      <Card>
        {card.tokens.length === 0 ? <ListRow title={t('card.tokens.none', locale)} last /> : null}
        {card.tokens.map((tok, i) => (
          <ListRow key={`${tok.wallet}-${tok.deviceId}`} title={tok.deviceId} trailing={t(`card.tokens.${tok.status}`, locale)} last={i === card.tokens.length - 1} />
        ))}
      </Card>
      {card.status === 'active' ? (
        <>
          <Button label={t('card.addToWallet.apple', locale)} variant="secondary" onPress={() => void model.addToWallet('apple')} disabled={s.busy} testID="card-wallet-apple" />
          <Button label={t('card.addToWallet.google', locale)} variant="secondary" onPress={() => void model.addToWallet('google')} disabled={s.busy} testID="card-wallet-google" />
        </>
      ) : null}
      {s.cards.length > 1 ? (
        <Card>
          {s.cards.map((c, i) => (
            <ListRow key={c.id} title={t(`card.type.${c.type}`, locale)} subtitle={t(`card.status.${c.status}`, locale)} {...(c.id === card.id ? { trailing: '•' } : {})} onPress={() => model.select(c.id)} last={i === s.cards.length - 1} />
          ))}
        </Card>
      ) : null}
      {card.status === 'closed' ? <Badge label={t('card.status.closed', locale)} tone="warning" /> : null}
    </Screen>
  );
}

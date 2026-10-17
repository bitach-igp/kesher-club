// M23 lost or stolen: close the card now, remove it from every wallet, and go straight to the
// replacement order for a physical card. Closing needs a fresh passkey step-up.
import { useEffect } from 'react';
import { Banner, Button, Card, ListRow, Screen, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import type { CardModel, LostReason } from './card.model.ts';
import { useCardModel } from './index.tsx';

export default function LostCardScreen() {
  return <LostCardView model={useCardModel()} />;
}

const REASONS: LostReason[] = ['lost', 'stolen', 'damaged'];

export function LostCardView({ model }: { model: CardModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void (s.mode === 'loading' && model.load()), [model, s.mode]);
  const card = model.selected();
  return (
    <Screen title={t('card.lost.title', locale)} {...(card ? { subtitle: `${t(`card.type.${card.type}`, locale)} · ${t('card.ending', locale, { last4: card.last4 })}` } : {})} testID="screen-card-lost">
      {s.needsStepUp ? <Banner tone="info" body={t('card.stepUp', locale)} testID="lost-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="lost-done" /> : null}
      <Txt>{t('card.lost.body', locale)}</Txt>
      <Card>
        {REASONS.map((r, i) => (
          <ListRow key={r} title={t(`card.lost.reason.${r}`, locale)} onPress={() => void model.reportLost(r)} last={i === REASONS.length - 1} testID={`lost-${r}`} />
        ))}
      </Card>
      {card?.status === 'active' || card?.status === 'inactive' ? <Button label={t('card.freeze', locale)} variant="secondary" onPress={() => void model.freeze()} loading={s.busy} testID="lost-freeze" /> : null}
    </Screen>
  );
}

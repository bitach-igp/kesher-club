// M21 card controls: toggles for ATM and online, the limits, blocked categories and allowed
// countries, each marked when the funder set it and disabled for the member with the reason.
import { useEffect } from 'react';
import { Banner, Card, ListRow, Screen, Skeleton, Toggle, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { controlRows, type CardModel } from './card.model.ts';
import { useCardModel } from './index.tsx';

export default function CardControlsScreen() {
  return <CardControlsView model={useCardModel()} />;
}

export function CardControlsView({ model }: { model: CardModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void (s.mode === 'loading' && model.load()), [model, s.mode]);
  const card = model.selected();
  if (!card) {
    return (
      <Screen title={t('card.controls.title', locale)} testID="screen-card-controls">
        <Skeleton />
      </Screen>
    );
  }
  const rows = controlRows(card, locale);
  return (
    <Screen title={t('card.controls.title', locale)} testID="screen-card-controls">
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="controls-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} /> : null}
      <Card>
        {rows
          .filter((r) => r.key === 'atm' || r.key === 'online')
          .map((r) => (
            <Toggle key={r.key} label={t(r.label, locale)} {...(r.locked ? { hint: t('card.locked.hint', locale) } : {})} value={r.value === true} onChange={(v) => void (r.locked || s.busy ? undefined : model.setToggle(r.key as 'atm' | 'online', v))} testID={`control-${r.key}`} />
          ))}
      </Card>
      <Card>
        {rows
          .filter((r) => r.key !== 'atm' && r.key !== 'online')
          .map((r, i, all) => (
            <ListRow key={r.key} title={t(r.label, locale)} {...(r.locked ? { subtitle: t('card.locked.hint', locale) } : {})} trailing={typeof r.value === 'string' && r.value ? r.value : t('card.controls.noLimit', locale)} last={i === all.length - 1} testID={`control-${r.key}`} />
          ))}
      </Card>
      {card.lockedByFunder.length ? <Txt tone="secondary">{t('card.locked.refused', locale)}</Txt> : null}
    </Screen>
  );
}

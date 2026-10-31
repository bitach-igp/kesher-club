// P09 a member's card in funder mode (T-0412): online and ATM, where the card works, the categories it refuses, and
// freeze. Each control the funder set says so and offers Hand back. Unfreezing asks for the passkey first.
import { useEffect, useMemo } from 'react';
import { useApi, type Card as CardData } from '../../src/api.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Toggle, Txt } from '../../src/components/index.ts';
import { t, useLocale, type Locale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useParams } from '../../src/navigation.ts';
import { uuidv7 } from '@kesher/domain';
import { BLOCKABLE_ORDER, COUNTRIES, createControlsModel, isBlocked, type ControlsModel, type FunderKey } from './controls.model.ts';

export default function FunderControlsScreen() {
  const api = useApi();
  const id = useParams()['card'] ?? '';
  const model = useMemo(() => createControlsModel({ cards: api.cards, newKey: uuidv7 }, id), [api, id]);
  return <FunderControlsView model={model} />;
}

/** "You set this" and Hand back, for a key the funder holds. */
function HandBack({ card, k, model, busy, locale }: { card: CardData; k: FunderKey; model: ControlsModel; busy: boolean; locale: Locale }) {
  if (!card.lockedByFunder.includes(k)) return null;
  return <ListRow title={t('controls.locked', locale)} trailing={t('controls.handBack', locale)} onPress={() => void (busy ? undefined : model.release(k))} last testID={`controls-release-${k}`} />;
}

export function FunderControlsView({ model }: { model: ControlsModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void model.load(), [model]);

  if (s.mode !== 'ready' || !s.card) {
    return (
      <Screen title={t('controls.title', locale)} testID="screen-funder-controls">
        {s.mode === 'error' ? <Banner tone="danger" body={t(s.error ?? 'common.error.generic', locale)} testID="controls-error" /> : <Skeleton />}
      </Screen>
    );
  }
  const card = s.card;
  const frozen = card.status === 'frozen';
  const anywhere = !card.controls.allowedCountries;
  const footer = frozen ? (
    <Button label={t('controls.unfreeze', locale)} onPress={() => void model.unfreeze()} disabled={s.busy} testID="controls-unfreeze" />
  ) : (
    <Button label={t('controls.freeze', locale)} variant="secondary" onPress={() => void model.freeze()} disabled={s.busy} testID="controls-freeze" />
  );

  return (
    <Screen title={t('member.card', locale, { last4: card.last4 })} testID="screen-funder-controls" footer={footer}>
      {frozen ? <Banner tone="danger" body={t('card.banner.frozen', locale)} /> : null}
      {s.needsStepUp ? <Banner tone="info" body={t('controls.stepUp', locale)} testID="controls-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="controls-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="controls-notice" /> : null}
      <Txt tone="secondary">{t('controls.intro', locale)}</Txt>

      {(['online', 'atm'] as const).map((k) => (
        <Card key={k} testID={`controls-${k}`}>
          <Toggle label={t(`card.controls.${k}`, locale)} value={card.controls[k]} onChange={(v) => void (s.busy ? undefined : model.setToggle(k, v))} testID={`controls-toggle-${k}`} />
          <HandBack card={card} k={k} model={model} busy={s.busy} locale={locale} />
        </Card>
      ))}

      <Card testID="controls-countries">
        <Txt variant="headline">{t('controls.countries.title', locale)}</Txt>
        <Toggle label={t('controls.countries.anywhere', locale)} value={anywhere} onChange={(v) => void (s.busy ? undefined : v ? model.anywhere() : model.setCountry('IL', true))} testID="controls-anywhere" />
        {anywhere
          ? null
          : COUNTRIES.map((c) => (
              <Toggle key={c} label={t(`controls.country.${c}`, locale)} value={card.controls.allowedCountries?.includes(c) ?? false} onChange={(v) => void (s.busy ? undefined : model.setCountry(c, v))} testID={`controls-country-${c}`} />
            ))}
        <HandBack card={card} k="allowedCountries" model={model} busy={s.busy} locale={locale} />
      </Card>

      <Card testID="controls-categories">
        <Txt variant="headline">{t('controls.categories.title', locale)}</Txt>
        {BLOCKABLE_ORDER.map((c) => (
          <Toggle key={c} label={t(`controls.category.${c}`, locale)} value={isBlocked(card, c)} onChange={(v) => void (s.busy ? undefined : model.setCategory(c, v))} testID={`controls-category-${c}`} />
        ))}
        <HandBack card={card} k="blockedMccs" model={model} busy={s.busy} locale={locale} />
      </Card>
    </Screen>
  );
}

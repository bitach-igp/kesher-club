// M17 split: a total and the other participants; each gets a request for an equal share and the
// member keeps the remainder.
import { useState } from 'react';
import { Banner, Button, Card, ListRow, Screen, TextField, Txt } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import { formatMoney, parseAmount, splitPreview, type PayModel } from './pay.model.ts';

export default function SplitScreen() {
  return <SplitView model={usePayModel()} />;
}

export function SplitView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const [draft, setDraft] = useState('');
  const parsed = parseAmount(s.split.totalText, s.currency);
  const preview = 'amount' in parsed ? splitPreview(parsed.amount, s.split.participants.length) : undefined;
  const n = s.split.participants.length;
  return (
    <Screen title={t('pay.split.title', locale)} testID="screen-pay-split" footer={<Button label={t('pay.split.action', locale, { n })} onPress={() => void model.createSplit()} loading={s.busy} disabled={!preview} testID="split-create" />}>
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="split-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="split-notice" /> : null}
      <TextField label={t('pay.split.total', locale)} value={s.split.totalText} onChangeText={model.setSplitTotal} keyboardType="decimal-pad" testID="split-total" />
      <Card>
        <Txt variant="headline">{t('pay.split.participants', locale)}</Txt>
        {s.split.participants.map((p, i) => (
          <ListRow key={p} title={p} trailing={t('pay.split.remove', locale)} onPress={() => model.removeParticipant(p)} last={i === n - 1} testID={`split-participant-${i}`} />
        ))}
        <TextField label={t('pay.split.add', locale)} value={draft} onChangeText={setDraft} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => (model.addParticipant(draft), setDraft(''))} testID="split-add" />
      </Card>
      {preview ? (
        <Txt tone="secondary" testID="split-preview">
          {t('pay.split.share', locale, { n, share: formatMoney(preview.share, locale) })} · {t('pay.split.yours', locale, { share: formatMoney(preview.yours, locale) })}
        </Txt>
      ) : null}
    </Screen>
  );
}

// M22 physical card order: a US or Israeli address, validated field by field, sent to the processor
// once and never kept on the phone or the API. After the order the card shows as on its way.
import { useEffect } from 'react';
import { Banner, Button, Screen, TextField, Toggle } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import type { AddressForm, CardModel } from './card.model.ts';
import { useCardModel } from './index.tsx';

export default function PhysicalCardScreen() {
  return <PhysicalCardView model={useCardModel()} />;
}

const FIELDS: { key: keyof AddressForm; label: 'card.physical.name' | 'card.physical.line1' | 'card.physical.line2' | 'card.physical.city' | 'card.physical.region' | 'card.physical.postalCode' }[] = [
  { key: 'name', label: 'card.physical.name' },
  { key: 'line1', label: 'card.physical.line1' },
  { key: 'line2', label: 'card.physical.line2' },
  { key: 'city', label: 'card.physical.city' },
  { key: 'region', label: 'card.physical.region' },
  { key: 'postalCode', label: 'card.physical.postalCode' },
];

export function PhysicalCardView({ model }: { model: CardModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  useEffect(() => void (s.mode === 'loading' && model.load()), [model, s.mode]);
  const a = s.address;
  return (
    <Screen title={t('card.physical.title', locale)} subtitle={t('card.physical.subtitle', locale)} testID="screen-card-physical" footer={<Button label={t('card.physical.order', locale)} onPress={() => void model.orderPhysical()} loading={s.busy} testID="physical-order" />}>
      {s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="physical-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice, locale)} testID="physical-notice" /> : null}
      <Toggle label={t('card.physical.country.US', locale)} hint={t('card.physical.country', locale)} value={a.country === 'US'} onChange={(v) => model.setAddress({ country: v ? 'US' : 'IL' })} testID="physical-country" />
      {FIELDS.filter((f) => f.key !== 'region' || a.country === 'US').map((f) => (
        <TextField key={f.key} label={t(f.label, locale)} value={a[f.key]} onChangeText={(v) => model.setAddress({ [f.key]: v })} {...(s.fieldError?.field === f.key ? { error: t(s.fieldError.key, locale, { field: t(f.label, locale) }) } : {})} autoCapitalize={f.key === 'postalCode' ? 'characters' : 'words'} testID={`physical-${f.key}`} />
      ))}
    </Screen>
  );
}

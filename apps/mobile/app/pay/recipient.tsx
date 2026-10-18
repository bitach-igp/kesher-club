// M13 recipient: a member id pasted, picked from contacts or scanned from a code. Names shown here are
// the member's own contact names, never server-trusted; the server resolves and verifies the member.
import { Banner, Button, Screen, TextField } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { usePayModel } from './index.tsx';
import type { PayModel } from './pay.model.ts';

export default function RecipientScreen() {
  return <RecipientView model={usePayModel()} />;
}

export function RecipientView({ model }: { model: PayModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  return (
    <Screen title={t('pay.recipient.title', locale)} testID="screen-pay-recipient" footer={<Button label={t('common.continue', locale)} onPress={model.goAmount} disabled={!s.recipient.trim()} testID="recipient-continue" />}>
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="recipient-error" /> : null}
      <TextField label={t('pay.recipient.label', locale)} helper={t('pay.recipient.helper', locale)} value={s.recipient} onChangeText={model.setRecipient} autoCapitalize="none" autoCorrect={false} testID="recipient-input" />
      <Button label={t('pay.recipient.contacts', locale)} variant="secondary" onPress={() => void model.pickContact()} testID="recipient-contacts" />
      <Button label={t('pay.recipient.scan', locale)} variant="secondary" onPress={() => void model.scan()} testID="recipient-scan" />
    </Screen>
  );
}

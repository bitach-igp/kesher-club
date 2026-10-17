// M31 Help hub: 24/7 call, WhatsApp, in-app chat, FAQs, and the emergency entry.
import { Button, Card, ListRow, Screen } from '../../src/components/index.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useOpener } from '../../src/linking.ts';
import { useRouter } from '../../src/navigation.ts';
import { telUrl, useSupport, whatsappUrl } from '../../src/support.ts';

export default function HelpHubScreen() {
  const locale = useLocale();
  const opener = useOpener();
  const router = useRouter();
  const support = useSupport();
  return (
    <Screen title={t('help.title', locale)} subtitle={t('help.subtitle', locale)} testID="screen-help" footer={<Button label={t('help.emergency', locale)} variant="destructive" accessibilityHint={t('help.emergency.sub', locale)} onPress={() => router.push('/help/emergency')} testID="help-emergency" />}>
      <Card>
        <ListRow title={t('help.call', locale)} subtitle={t('help.call.sub', locale)} onPress={() => void opener.openURL(telUrl(support.helpLine))} testID="help-call" />
        <ListRow title={t('help.whatsapp', locale)} subtitle={t('help.whatsapp.sub', locale)} onPress={() => void opener.openURL(whatsappUrl(support.whatsapp))} testID="help-whatsapp" />
        <ListRow title={t('help.chat', locale)} subtitle={t('help.chat.sub', locale)} onPress={() => router.push('/help/chat')} testID="help-chat" />
        <ListRow title={t('help.faq', locale)} subtitle={t('help.faq.sub', locale)} onPress={() => void opener.openURL(support.faqUrl)} testID="help-faq" last />
      </Card>
    </Screen>
  );
}

// M03 sign in / sign up. One screen, four states: passkey prompt (default), recovery phone,
// sign-up phone, OTP verify, then passkey enrolment. Tab 2: "Locked out, OTP expired" edge states.
import { useMemo } from 'react';
import { View } from 'react-native';
import { useApi } from '../../src/api.ts';
import { Banner, Button, OtpInput, Screen, TextField, Txt } from '../../src/components/index.ts';
import { useNow } from '../../src/clock.ts';
import { t, useLocale } from '../../src/i18n.ts';
import { useStore } from '../../src/model.ts';
import { useRouter } from '../../src/navigation.ts';
import { useAuthenticator } from '../../src/passkeys.ts';
import { useSession } from '../../src/session.ts';
import { useTheme } from '../../src/theme.ts';
import { createSignInModel, type SignInModel } from './signin.model.ts';

export function useSignInModel(): SignInModel {
  const api = useApi();
  const authenticator = useAuthenticator();
  const session = useSession();
  const router = useRouter();
  const now = useNow();
  const locale = useLocale();
  return useMemo(() => createSignInModel({ api: api.auth, authenticator, session, router, now, locale }), [api, authenticator, session, router, now, locale]);
}

/** Route component: builds the model from the app contexts. */
export default function SignInScreen() {
  return <SignInView model={useSignInModel()} />;
}

/** Pure view over a model; tests and previews render this directly. */
export function SignInView({ model }: { model: SignInModel }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const th = useTheme();
  const err = s.error ? <Banner tone="danger" body={t(s.error, locale)} testID="signin-error" /> : null;

  if (s.mode === 'passkey' || s.mode === 'done') {
    return (
      <Screen
        title={t('signin.title', locale)}
        subtitle={t('signin.subtitle', locale)}
        testID="screen-signin"
        footer={
          <>
            <Button label={t('signin.passkey', locale)} onPress={() => void model.signInWithPasskey()} loading={s.busy} testID="signin-passkey" />
            <Button label={t('signin.cantUsePasskey', locale)} variant="tertiary" onPress={model.cantUsePasskey} testID="signin-cant-use-passkey" />
          </>
        }
      >
        {err}
        <Button label={t('signin.switch.toSignup', locale)} variant="tertiary" onPress={model.startSignUp} testID="signin-to-signup" />
      </Screen>
    );
  }

  if (s.mode === 'recovery' || s.mode === 'signup') {
    const signup = s.mode === 'signup';
    return (
      <Screen
        title={t(signup ? 'signin.signup.title' : 'signin.recovery.title', locale)}
        subtitle={t(signup ? 'signin.signup.subtitle' : 'signin.recovery.subtitle', locale)}
        testID={signup ? 'screen-signup' : 'screen-recovery'}
        footer={
          <>
            <Button label={t('signin.sendCode', locale)} onPress={() => void model.sendCode()} loading={s.busy} disabled={s.phone.trim().length < 4} testID="signin-send-code" />
            <Button label={t('common.back', locale)} variant="tertiary" onPress={model.backToPasskey} />
          </>
        }
      >
        {err}
        <TextField
          label={t('signin.phone.label', locale)}
          helper={t('signin.phone.helper', locale)}
          value={s.phone}
          onChangeText={model.setPhone}
          keyboardType="phone-pad"
          inputMode="tel"
          textContentType="telephoneNumber"
          autoComplete="tel"
          testID="signin-phone"
        />
        <Button label={t(signup ? 'signin.switch.toRecovery' : 'signin.switch.toSignup', locale)} variant="tertiary" onPress={signup ? model.cantUsePasskey : model.startSignUp} />
      </Screen>
    );
  }

  if (s.mode === 'verify' || s.mode === 'locked') {
    const locked = s.mode === 'locked';
    return (
      <Screen
        title={t('verify.title', locale)}
        subtitle={t('verify.subtitle', locale, { phone: s.phone })}
        testID="screen-verify"
        footer={
          <>
            <Button label={t('common.continue', locale)} onPress={() => void model.submitCode()} loading={s.busy} disabled={locked || s.code.length !== 6} testID="verify-submit" />
            <Button label={t('verify.resend', locale)} variant="tertiary" onPress={() => void model.resendCode()} disabled={s.busy} testID="verify-resend" />
          </>
        }
      >
        {locked ? <Banner tone="danger" body={t('verify.locked', locale)} testID="verify-locked" /> : null}
        <OtpInput value={s.code} onChange={model.setCode} label={t('verify.code.label', locale)} disabled={locked || s.busy} {...(s.error && !locked ? { error: t(s.error, locale) } : {})} />
        {!locked && s.attemptsLeft > 0 && s.attemptsLeft < 5 ? (
          <Txt variant="caption" tone="warning" testID="verify-attempts">
            {t('verify.attemptsLeft', locale, { n: s.attemptsLeft })}
          </Txt>
        ) : null}
      </Screen>
    );
  }

  // enrol
  return (
    <Screen
      title={t('verify.passkey.title', locale)}
      subtitle={t('verify.passkey.subtitle', locale)}
      testID="screen-enrol"
      footer={<Button label={t('verify.passkey.create', locale)} onPress={() => void model.createPasskey()} loading={s.busy} testID="enrol-create" />}
    >
      {err}
      {s.purpose === 'recovery' ? <Banner tone="warning" body={t('verify.recoveryHold', locale)} testID="recovery-hold" /> : null}
      <View style={{ height: th.space[4] }} />
    </Screen>
  );
}

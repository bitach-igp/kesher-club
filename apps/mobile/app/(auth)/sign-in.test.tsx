// @vitest-environment jsdom
// Screen smoke test through react-native-web: the passkey button is the primary action and no OTP
// field is on the first screen (REQ-AUTH-002). Behaviour lives in signin.model.test.ts.
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { fakeAuthenticator } from '../../src/passkeys.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { memorySession } from '../../src/session.ts';
import type { AuthApi } from '../../src/api.ts';
import { createSignInModel } from './signin.model.ts';
import { SignInView } from './sign-in.tsx';

const api: AuthApi = {
  startOtp: async () => ({ otpId: 'o', expiresAt: '2030-01-01T00:00:00Z', attemptsAllowed: 5 }),
  verifyOtp: async () => ({ verified: false, attemptsLeft: 4 }),
  registerPasskey: async () => ({}),
  authenticatePasskey: async ({ response }) => (response ? { tokens: { accessToken: 'a', refreshToken: 'r', accessExpiresAt: '2030-01-01T00:00:00Z' } } : { options: {} as Record<string, never> }),
};

describe('M03 screen', () => {
  it('renders the passkey prompt first and reveals the phone field only behind "Can\'t use passkey?"', async () => {
    const model = createSignInModel({ api, authenticator: fakeAuthenticator(), session: memorySession(), router: memoryRouter(), now: () => new Date(), locale: 'en' });
    render(<SignInView model={model} />);
    expect(screen.getByTestId('signin-passkey')).toBeTruthy();
    expect(screen.queryByTestId('signin-phone')).toBeNull();
    await act(async () => model.cantUsePasskey());
    expect(screen.getByTestId('screen-recovery')).toBeTruthy();
    expect(screen.getByTestId('signin-phone')).toBeTruthy();
  });
});

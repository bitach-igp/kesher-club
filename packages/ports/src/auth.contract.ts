// AuthPort contract suite (TST-AUTH-001/002 at the port layer). Runs on the simulator every PR.
import { describe, expect, it } from 'vitest';
import type { AuthPort, PasskeyAuthenticationOptions, PasskeyRegistrationOptions, PasskeyRegistrationResponse, PasskeyAuthenticationResponse } from './auth.ts';
import { AuthError } from './auth.ts';

export interface AuthContractOptions {
  /** How the test obtains the OTP code the port sent (simulator: lastCode; sandbox: a test number's fixed code). */
  otpCode: (port: AuthPort) => string;
  /** A fake authenticator the suite can drive. */
  device: () => {
    register(o: PasskeyRegistrationOptions): Promise<PasskeyRegistrationResponse>;
    authenticate(o: PasskeyAuthenticationOptions): Promise<PasskeyAuthenticationResponse>;
  };
  outagePhone?: string;
}

export function authContract(name: string, make: () => AuthPort, opts: AuthContractOptions): void {
  describe(`AuthPort contract: ${name}`, () => {
    it('starts an OTP with a 5-minute expiry and 5 attempts', async () => {
      const port = make();
      const start = await port.startOtp('+972501234567');
      expect(start.attemptsAllowed).toBe(5);
      expect(Date.parse(start.expiresAt)).toBeGreaterThan(Date.now() - 1 || 0);
    });

    it('verifies the right code once and refuses the wrong one, counting attempts down', async () => {
      const port = make();
      const { otpId } = await port.startOtp('+972501234567');
      const wrong = await port.verifyOtp(otpId, '000000');
      expect(wrong.verified).toBe(false);
      expect(wrong.attemptsLeft).toBe(4);
      const right = await port.verifyOtp(otpId, opts.otpCode(port));
      expect(right.verified).toBe(true);
      expect(right.otpSessionToken).toBeTruthy();
      await expect(port.verifyOtp(otpId, opts.otpCode(port))).rejects.toBeInstanceOf(AuthError);
    });

    it('exhausts after five wrong codes', async () => {
      const port = make();
      const { otpId } = await port.startOtp('+972501234567');
      for (let i = 0; i < 4; i++) await port.verifyOtp(otpId, '111111');
      await expect(port.verifyOtp(otpId, '111111')).rejects.toMatchObject({ code: 'OTP_ATTEMPTS_EXHAUSTED' });
    });

    it('registers a passkey with ES256/EdDSA only and verifies a signed challenge', async () => {
      const port = make();
      const options = await port.registrationOptions({ id: 'u_1', name: 'noa@example.com' });
      expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8]);
      expect(options.authenticatorSelection.userVerification).toBe('required');
      const cred = await port.verifyRegistration(options, await opts.device().register(options));
      expect(cred.userId).toBe('u_1');
      expect(cred.counter).toBe(0);
    });

    it('rejects a reused registration challenge', async () => {
      const port = make();
      const options = await port.registrationOptions({ id: 'u_1', name: 'noa' });
      const response = await opts.device().register(options);
      await port.verifyRegistration(options, response);
      await expect(port.verifyRegistration(options, response)).rejects.toMatchObject({ code: 'CHALLENGE_MISMATCH' });
    });

    it('authenticates with the stored credential and detects counter replay', async () => {
      const port = make();
      const device = opts.device();
      const regOptions = await port.registrationOptions({ id: 'u_2', name: 'dani' });
      const stored = await port.verifyRegistration(regOptions, await device.register(regOptions));
      const authOptions = await port.authenticationOptions([stored]);
      const assertion = await device.authenticate(authOptions);
      const result = await port.verifyAuthentication(authOptions, assertion, stored);
      expect(result).toMatchObject({ verified: true, newCounter: assertion.counter });
      // A replay of the same assertion (same challenge, same counter) must fail.
      const replay = await port.verifyAuthentication(authOptions, assertion, { ...stored, counter: assertion.counter });
      expect(replay.verified).toBe(false);
    });

    it('rejects an assertion signed by a different key', async () => {
      const port = make();
      const honest = opts.device();
      const thief = opts.device();
      const regOptions = await port.registrationOptions({ id: 'u_3', name: 'x' });
      const stored = await port.verifyRegistration(regOptions, await honest.register(regOptions));
      await thief.register(await port.registrationOptions({ id: 'u_4', name: 'y' }));
      const authOptions = await port.authenticationOptions([stored]);
      const forged = { ...(await thief.authenticate(authOptions)), credentialId: stored.credentialId };
      expect((await port.verifyAuthentication(authOptions, forged, stored)).verified).toBe(false);
    });

    if (opts.outagePhone) {
      it('surfaces an SMS provider outage as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().startOtp(opts.outagePhone!)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

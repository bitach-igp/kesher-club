import { describe, expect, it } from 'vitest';
import { authContract } from './auth.contract.ts';
import { AuthSimulator, SIM_OTP_CODE, SIM_OTP_OUTAGE_PHONE, SimPasskeyDevice } from './auth.simulator.ts';
import { fixedClock, type AdvanceableClock } from './base.ts';

authContract('simulator', () => new AuthSimulator(), {
  otpCode: () => SIM_OTP_CODE,
  device: () => new SimPasskeyDevice(),
  outagePhone: SIM_OTP_OUTAGE_PHONE,
});

describe('AuthSimulator specifics', () => {
  it('expires an OTP after five minutes (REQ-AUTH-001)', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const sim = new AuthSimulator(clock);
    const { otpId } = await sim.startOtp('+15551234567');
    clock.advance(5 * 60_000 + 1);
    await expect(sim.verifyOtp(otpId, SIM_OTP_CODE)).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('refuses a passkey ceremony from a foreign origin', async () => {
    const sim = new AuthSimulator();
    const options = await sim.registrationOptions({ id: 'u', name: 'n' });
    const phishing = new SimPasskeyDevice('https://kesher-club-login.example');
    await expect(sim.verifyRegistration(options, await phishing.register(options))).rejects.toMatchObject({ code: 'CHALLENGE_MISMATCH' });
  });
});

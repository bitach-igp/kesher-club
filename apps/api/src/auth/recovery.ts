// Recovery (T-0114, REQ-AUTH-003): OTP recovery re-keys the account with a new passkey, signs out
// every bound device, notifies them, and holds the account for 24 h: no money out, no new payees,
// no agent grants. THR-01 (SIM swap) is the threat this answers.
import { DomainError } from '@kesher/domain';
import type { Clock, NotifyPort, PasskeyRegistrationOptions, PasskeyRegistrationResponse } from '@kesher/ports';
import type { Principal } from '../http.ts';
import type { OtpService } from './otp.ts';
import type { PasskeyService } from './passkeys.ts';
import type { IdentityRepository } from './repository.ts';
import type { TokenPair, TokenService } from './tokens.ts';

export const RECOVERY_HOLD_MS = 24 * 3_600_000;

/** Actions blocked during the hold. Everything else (loads in, freezing a card, viewing) stays open. */
export type RestrictedAction = 'p2p_send' | 'payout' | 'fx_convert' | 'new_payee' | 'agent_grant' | 'card_push_provisioning' | 'addon_purchase_over_limit';
export type OpenAction = 'load' | 'card_freeze' | 'view' | 'addon_purchase';

const RESTRICTED = new Set<string>(['p2p_send', 'payout', 'fx_convert', 'new_payee', 'agent_grant', 'card_push_provisioning', 'addon_purchase_over_limit']);

export function assertNotRestricted(principal: Principal, action: RestrictedAction | OpenAction, now: Date): void {
  if (!RESTRICTED.has(action)) return;
  if (principal.restrictedUntil && Date.parse(principal.restrictedUntil) > now.getTime()) {
    throw new DomainError('RECOVERY_HOLD', 'Your account was recently recovered; this action is available after the 24-hour hold', { restrictedUntil: principal.restrictedUntil });
  }
}

export interface RecoverInput {
  otpSessionToken: string;
  deviceId: string;
  deviceName: string;
  response?: PasskeyRegistrationResponse;
}

export class RecoveryService {
  private readonly pending = new Map<string, { partyId: string; phone: string }>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly otp: OtpService,
    private readonly passkeys: PasskeyService,
    private readonly tokens: TokenService,
    private readonly notify: NotifyPort,
    private readonly clock: Clock,
  ) {}

  /** Two-step like registration; the otp-session is consumed on the first step and remembered for the second. */
  async recover(input: RecoverInput): Promise<{ options?: PasskeyRegistrationOptions; tokens?: TokenPair }> {
    const now = this.clock.now();
    let target = this.pending.get(input.otpSessionToken);
    if (!target) {
      const { phone } = await this.otp.consumeSession(input.otpSessionToken, 'recovery');
      const user = await this.repo.findUserByPhone(phone);
      // Same error either way: do not reveal whether the phone has an account.
      if (!user || user.status === 'closed') throw new DomainError('UNAUTHENTICATED', 'Recovery could not be completed');
      target = { partyId: user.partyId, phone };
      this.pending.set(input.otpSessionToken, target);
    }
    if (!input.response) {
      const step = await this.passkeys.register({ deviceId: input.deviceId, deviceName: input.deviceName, recoveryFor: target.partyId });
      return { options: step.options! };
    }
    this.pending.delete(input.otpSessionToken);

    // Order matters: hold first, so the tokens issued below already carry it.
    const until = new Date(now.getTime() + RECOVERY_HOLD_MS).toISOString();
    await this.repo.setRestriction(target.partyId, until, 'otp_recovery');
    await this.repo.setUserStatus(target.partyId, 'restricted');

    const devices = await this.repo.listDevices(target.partyId);
    await this.repo.removePasskeys(target.partyId);
    await this.tokens.revokeAll(target.partyId, 'otp_recovery');

    const step = await this.passkeys.register({ deviceId: input.deviceId, deviceName: input.deviceName, recoveryFor: target.partyId, response: input.response });
    const tokens = await this.tokens.issue({ partyId: target.partyId, deviceId: input.deviceId, roles: (await this.repo.findUser(target.partyId))?.roles ?? ['member'] });

    for (const d of devices) {
      if (d.deviceId === input.deviceId || !d.pushToken) continue;
      await this.notify.send(
        { channel: 'push', to: d.pushToken, template: 'security.account_recovered', locale: 'en', data: { device: input.deviceName }, category: 'security' },
        `recovery:${target.partyId}:${d.deviceId}:${now.getTime()}`,
      ).catch(() => undefined); // best effort: a dead push token never blocks recovery
    }
    void step;
    return { tokens };
  }
}

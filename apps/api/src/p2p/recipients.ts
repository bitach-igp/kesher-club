// Who a member is about to pay (T-0530, REQ-PAY-001). A phone number or a member id resolves to:
// - the recipient's id;
// - the name they set (T-0531), "Avi E.", and nothing more;
// - whether they can receive (T1, account open).
// A number that is not a member, or a closed account, answers the same 404 with no hint, so a lookup says
// nothing about who is not here. Each member gets 30 lookups a minute; the 31st answers RATE_LIMITED, which
// keeps enumeration slow. The window is held in this process: with N API processes a member gets up to 30 × N.
import { DomainError } from '@kesher/domain';
import type { IdentityRepository } from '../auth/repository.ts';
import type { KycService } from '../kyc/service.ts';
import type { DisplayNameService } from '../me/display-name.ts';

export const LOOKUPS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedRecipient {
  partyId: string;
  /** "Avi E.", or absent while the recipient has set no name. Member text: shown as text. */
  displayName?: string;
  canReceive: boolean;
}

export interface RecipientDeps {
  identity: Pick<IdentityRepository, 'findUser' | 'findUserByPhone'>;
  kyc: Pick<KycService, 'isApproved'>;
  names: Pick<DisplayNameService, 'get'>;
}

export class RecipientLookup {
  private readonly d: RecipientDeps;
  private readonly recent = new Map<string, number[]>();
  constructor(d: RecipientDeps) {
    this.d = d;
  }

  async resolve(byPartyId: string, input: { phone?: unknown; memberId?: unknown }, now: Date): Promise<ResolvedRecipient> {
    const phone = typeof input.phone === 'string' ? input.phone.replace(/[\s()-]/g, '') : undefined;
    const memberId = typeof input.memberId === 'string' ? input.memberId.trim() : undefined;
    if ((phone === undefined) === (memberId === undefined)) throw new DomainError('VALIDATION_FAILED', 'Send exactly one of phone or memberId');
    if (phone !== undefined && !E164.test(phone)) throw new DomainError('VALIDATION_FAILED', 'phone must be in international form, like +972501234567', { field: 'phone' });
    if (memberId !== undefined && !UUID.test(memberId)) throw new DomainError('VALIDATION_FAILED', 'memberId must be a member id', { field: 'memberId' });
    this.count(byPartyId, now);
    const user = phone !== undefined ? await this.d.identity.findUserByPhone(phone) : await this.d.identity.findUser(memberId!);
    if (!user || user.status === 'closed') throw new DomainError('NOT_FOUND', 'No member to pay there');
    const [name, verified] = await Promise.all([this.d.names.get(user.partyId), this.d.kyc.isApproved(user.partyId, 'T1')]);
    return { partyId: user.partyId, ...(name.displayName ? { displayName: name.displayName } : {}), canReceive: verified && user.status !== 'pending' };
  }

  /** A sliding minute per member; a refused lookup counts too, so probing costs the same either way. */
  private count(partyId: string, now: Date): void {
    const since = now.getTime() - WINDOW_MS;
    const kept = (this.recent.get(partyId) ?? []).filter((t) => t > since);
    if (kept.length >= LOOKUPS_PER_MINUTE) {
      this.recent.set(partyId, kept);
      throw new DomainError('RATE_LIMITED', 'Too many lookups; try again in a minute');
    }
    kept.push(now.getTime());
    this.recent.set(partyId, kept);
  }
}

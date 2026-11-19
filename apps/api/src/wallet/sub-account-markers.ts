// Our own markers in ops.external_ref (T-0762): not vendor refs, so they live here and not in @kesher/ports. The stored strings are fixed:
//   `o:{partyId}:failed`                          the owner the vendor refused (entity type `funding_subaccount_owner`)
//   `p:{partyId}:{16 hex of sha256(purpose)}`     the purpose a sub-account was opened for (entity type `funding_subaccount_purpose`)
// Callers build and compare through these functions only. The `s:` refs are the port's grammar (`subAccountRef` in @kesher/ports).
import { createHash } from 'node:crypto';

export const normalizePurpose = (purpose: string): string => purpose.trim().toLowerCase();
/** 16 hex characters of the normalized purpose: non-PII, and short enough that the port key stays under 128 characters. */
export const purposeHash = (purpose: string): string => createHash('sha256').update(normalizePurpose(purpose)).digest('hex').slice(0, 16);

export const ownerFailedMarker = (partyId: string): string => `o:${partyId}:failed`;
export const isOwnerFailedMarker = (partyId: string, value: unknown): boolean => value === ownerFailedMarker(partyId);

export const purposeMarker = (partyId: string, purpose: string): string => `p:${partyId}:${purposeHash(purpose)}`;
/** The party and purpose hash inside a purpose marker, or undefined for any other string. The party id may itself contain `:`; the hash is the last 16 hex. */
export function parsePurposeMarker(value: unknown): { partyId: string; hash: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^p:(.+):([0-9a-f]{16})$/.exec(value);
  return m ? { partyId: m[1]!, hash: m[2]! } : undefined;
}

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isOwnerFailedMarker, ownerFailedMarker, parsePurposeMarker, purposeHash, purposeMarker } from './sub-account-markers.ts';

const P = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const Q = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const hash16 = (purpose: string): string => createHash('sha256').update(purpose.trim().toLowerCase()).digest('hex').slice(0, 16);

describe('sub-account marker grammar (T-0762)', () => {
  it('keeps the stored strings byte-identical', () => {
    expect(ownerFailedMarker(P)).toBe(`o:${P}:failed`);
    expect(purposeMarker(P, '  Test-Purpose ')).toBe(`p:${P}:${hash16('test-purpose')}`);
    expect(purposeMarker(P, 'x')).toMatch(/^p:[^:]+:[0-9a-f]{16}$/);
  });

  it('isOwnerFailedMarker is the inverse and never matches another party', () => {
    expect(isOwnerFailedMarker(P, ownerFailedMarker(P))).toBe(true);
    expect(isOwnerFailedMarker(Q, ownerFailedMarker(P))).toBe(false);
    expect(isOwnerFailedMarker(P, `o:${P}:failed `)).toBe(false);
    expect(isOwnerFailedMarker(P, `o:${P}`)).toBe(false);
    expect(isOwnerFailedMarker(P, undefined)).toBe(false);
  });

  it('purpose markers parse back, normalise the purpose, and differ per party', () => {
    expect(parsePurposeMarker(purposeMarker(P, 'Dues'))).toEqual({ partyId: P, hash: hash16('dues') });
    expect(purposeMarker(P, ' DUES ')).toBe(purposeMarker(P, 'dues'));
    expect(purposeMarker(P, 'dues')).not.toBe(purposeMarker(Q, 'dues'));
    expect(parsePurposeMarker('p:abc')).toBeUndefined();
    expect(parsePurposeMarker(`p:${P}:xyz`)).toBeUndefined();
    expect(parsePurposeMarker(`p:${P}:${hash16('a')}0`)).toBeUndefined();
    expect(parsePurposeMarker(`s:${P}:${hash16('a')}`)).toBeUndefined();
  });

  it('a purpose marker never parses as an owner marker, nor the reverse', () => {
    expect(isOwnerFailedMarker(P, purposeMarker(P, 'failed'))).toBe(false);
    expect(parsePurposeMarker(ownerFailedMarker(P))).toBeUndefined();
  });

  it('parsePurposeMarker is anchored at the start and takes lower-case hex only', () => {
    const h = hash16('a');
    expect(parsePurposeMarker(`p:${P}:${h}`)).toEqual({ partyId: P, hash: h });
    expect(parsePurposeMarker(`x p:${P}:${h}`)).toBeUndefined();
    expect(parsePurposeMarker(`junkp:${P}:${h}`)).toBeUndefined();
    expect(parsePurposeMarker(`p:${P}:${h.toUpperCase()}`)).toBeUndefined();
    expect(parsePurposeMarker(`p:${P}:${h.slice(0, 15)}A`)).toBeUndefined();
    expect(parsePurposeMarker(`p:${P}:${h}\n`)).toBeUndefined();
  });

  it('a party id that contains ":" round-trips (the doc comment says it may; the hash is the last 16 hex)', () => {
    const party = 'org:42:member';
    expect(parsePurposeMarker(purposeMarker(party, 'dues'))).toEqual({ partyId: party, hash: hash16('dues') });
  });
});

describe('purposeHash (T-0762)', () => {
  // Vectors from node:crypto computed outside the code: first 16 hex of sha256 over the UTF-8 of the trimmed, lower-cased purpose.
  it('is pinned: trimmed and lower-cased, nothing else', () => {
    expect(purposeHash(' Stipend ')).toBe('381ec8e417b6913b');
    expect(purposeHash('stipend')).toBe('381ec8e417b6913b');
    expect(purposeHash('a  b')).toBe('6e12db73209a66d1');
  });

  it('keeps a double space inside the purpose (only the edges are trimmed)', () => {
    expect(purposeHash('a  b')).not.toBe(purposeHash('a b'));
  });

  it('does no unicode normalisation: precomposed and decomposed e-acute differ', () => {
    expect(purposeHash('\u00e9')).toBe('4a99557e4033c353');
    expect(purposeHash('e\u0301')).toBe('bf12767b0f2a56b2');
    expect(purposeHash('\u00e9')).not.toBe(purposeHash('e\u0301'));
  });
});

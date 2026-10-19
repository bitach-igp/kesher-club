// T-0024: sealing and the blind index. Keys are throwaway test values; nothing here is a real secret.
import { randomBytes } from 'node:crypto';
import { Secret } from '@kesher/domain';
import { describe, expect, it } from 'vitest';
import { createPiiCipher, PiiSealError } from './pii.ts';

const key = () => new Secret(randomBytes(32).toString('base64'));
const PHONE = 'identity.user_account.phone';
const cipher = createPiiCipher({ dataKey: key(), indexKey: key() });

describe('PII sealing (T-0024)', () => {
  it('opens what it sealed, with a fresh iv each time', () => {
    const a = cipher.seal('+972501234567', PHONE);
    const b = cipher.seal('+972501234567', PHONE);
    expect(a.equals(b)).toBe(false);
    expect(cipher.open(a, PHONE)).toBe('+972501234567');
    expect(cipher.open(b, PHONE)).toBe('+972501234567');
    expect(a[0]).toBe(1);
    expect(a.includes(Buffer.from('+972501234567'))).toBe(false);
  });

  it('refuses a value moved to another column, tampered, truncated or of an unknown version', () => {
    const sealed = cipher.seal('+12125550100', PHONE);
    expect(() => cipher.open(sealed, 'identity.otp_session.phone')).toThrow(PiiSealError);
    const flipped = Buffer.from(sealed);
    flipped[20] = flipped[20]! ^ 0x01;
    expect(() => cipher.open(flipped, PHONE)).toThrow(PiiSealError);
    expect(() => cipher.open(sealed.subarray(0, 20), PHONE)).toThrow(/too short/);
    const v2 = Buffer.from(sealed);
    v2[0] = 2;
    expect(() => cipher.open(v2, PHONE)).toThrow(/unknown version/);
  });

  it('never puts the plaintext in an error', () => {
    const sealed = cipher.seal('+972509999999', PHONE);
    try {
      cipher.open(sealed, 'elsewhere');
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('972509999999');
    }
  });

  it('a different data key cannot open it', () => {
    const other = createPiiCipher({ dataKey: key(), indexKey: key() });
    expect(() => other.open(cipher.seal('+12125550100', PHONE), PHONE)).toThrow(PiiSealError);
  });

  it('indexes deterministically per column, one way, and never with the data key', () => {
    const dataKey = key();
    const c = createPiiCipher({ dataKey, indexKey: key() });
    const i = c.index('+972501234567', PHONE);
    expect(i).toHaveLength(32);
    expect(c.index('+972501234567', PHONE).equals(i)).toBe(true);
    expect(c.index('+972501234568', PHONE).equals(i)).toBe(false);
    expect(c.index('+972501234567', 'identity.otp_start.phone').equals(i)).toBe(false);
    // Same data key, different index key: different index, so the index key is the only way in.
    expect(createPiiCipher({ dataKey, indexKey: key() }).index('+972501234567', PHONE).equals(i)).toBe(false);
  });

  it('refuses short, malformed or reused keys', () => {
    expect(() => createPiiCipher({ dataKey: new Secret(randomBytes(16).toString('base64')), indexKey: key() })).toThrow(/32 bytes/);
    const same = key();
    expect(() => createPiiCipher({ dataKey: same, indexKey: same })).toThrow(/must differ/);
  });
});

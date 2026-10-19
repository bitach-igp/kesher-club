// Field-level PII sealing (T-0024, constitution art. 9). A PII column holds `version ‖ iv ‖ ciphertext ‖
// tag` (AES-256-GCM) with the column's name as associated data, so a value copied into another column
// will not open there. Lookups and uniqueness go through a blind index: HMAC-SHA256 under a second key,
// with the column's name mixed in, so the same phone indexes differently in two tables and the index
// key can never decrypt anything. Both keys reach the process from Secrets Manager (KMS-encrypted,
// T-0003), which is the envelope; this module never logs, and its errors never carry plaintext.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Secret } from '@kesher/domain';

/** The first byte of every sealed value. A later keyring adds versions; an unknown one never opens. */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface PiiCipher {
  /** Seals `value` for the column named `context` (e.g. `identity.user_account.phone`). */
  seal(value: string, context: string): Buffer;
  /** Opens a value sealed for the same `context`; throws on any tampering, truncation or unknown version. */
  open(sealed: Uint8Array, context: string): string;
  /** The blind index of `value` for `context`: 32 bytes, deterministic, one-way. */
  index(value: string, context: string): Buffer;
}

export class PiiSealError extends Error {
  constructor(reason: string) {
    super(`PII value could not be opened: ${reason}`);
    this.name = 'PiiSealError';
  }
}

/** Decodes a base64 key and insists on 32 bytes; the config validates the same rule at boot. */
export function decodeKey(secret: Secret): Buffer {
  const key = Buffer.from(secret.reveal(), 'base64');
  if (key.length !== 32) throw new Error('A PII key must be 32 bytes, base64-encoded');
  return key;
}

export function createPiiCipher(keys: { dataKey: Secret; indexKey: Secret }): PiiCipher {
  const dataKey = decodeKey(keys.dataKey);
  const indexKey = decodeKey(keys.indexKey);
  if (dataKey.equals(indexKey)) throw new Error('The PII data key and index key must differ');
  return {
    seal(value, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.of(VERSION), iv, body, cipher.getAuthTag()]);
    },
    open(sealed, context) {
      const buf = Buffer.from(sealed);
      if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new PiiSealError('too short');
      if (buf[0] !== VERSION) throw new PiiSealError('unknown version');
      const iv = buf.subarray(1, 1 + IV_BYTES);
      const tag = buf.subarray(buf.length - TAG_BYTES);
      // The tag length is pinned, so Node itself refuses a shorter tag (a truncated GCM tag weakens the check).
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      try {
        // GCM authenticates in final(): nothing is returned unless the whole value verifies.
        return Buffer.concat([decipher.update(buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        throw new PiiSealError('authentication failed');
      }
    },
    index(value, context) {
      // Length-prefix the context so ("ab", "c") and ("a", "bc") can never collide.
      return createHmac('sha256', indexKey).update(`${context.length}:${context}:`).update(value, 'utf8').digest();
    },
  };
}

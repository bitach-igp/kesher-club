// SHA-256 digests shared by token and code storage: the table keeps the digest, never a usable credential.
import { createHash } from 'node:crypto';

/** SHA-256 of `s` as base64url text (the form token_hash text columns hold). */
export const sha256Url = (s: string): string => createHash('sha256').update(s).digest('base64url');

/** SHA-256 of `s` as raw bytes (the form bytea columns hold). */
export const sha256Buf = (s: string): Buffer => createHash('sha256').update(s).digest();

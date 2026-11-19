import { describe, expect, it } from 'vitest';
import { sha256Buf, sha256Url } from './hash.ts';

describe('sha256 helpers', () => {
  it('match the known digest of "abc" and agree with each other', () => {
    const hex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sha256Buf('abc').toString('hex')).toBe(hex);
    expect(sha256Url('abc')).toBe(Buffer.from(hex, 'hex').toString('base64url'));
    expect(sha256Url('abc')).toBe(sha256Buf('abc').toString('base64url'));
  });
});

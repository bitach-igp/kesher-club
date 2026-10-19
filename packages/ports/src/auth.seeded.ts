// A passkey whose ES256 key derives from a seed (T-0033): the demo's personas sign in with the same
// credential from the seed script on Node and from the member app in a browser. Simulator only: anyone
// holding the seed can sign, which is the point for a demo and why its RP is `kesher.example`. WebCrypto
// throughout, with no `node:` import, so a browser bundle can carry it.
//
// WebCrypto cannot derive a public key from a bare private scalar (Chromium refuses a PKCS#8 key without
// its public point), so the point is computed here, once per persona, with plain P-256 arithmetic. Not
// constant-time and not for real keys: it only ever multiplies a demo seed.
import type { PasskeyAuthenticationOptions, PasskeyAuthenticationResponse, PasskeyRegistrationOptions, PasskeyRegistrationResponse } from './auth.ts';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G = { x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n };

type Point = { x: bigint; y: bigint } | null;
const mod = (a: bigint, m = P): bigint => ((a % m) + m) % m;
const inv = (a: bigint): bigint => {
  let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0);
};
const add = (p: Point, q: Point): Point => {
  if (!p) return q;
  if (!q) return p;
  if (p.x === q.x && mod(p.y + q.y) === 0n) return null;
  const l = p.x === q.x ? mod((3n * p.x * p.x + A) * inv(2n * p.y)) : mod((q.y - p.y) * inv(q.x - p.x));
  const x = mod(l * l - p.x - q.x);
  return { x, y: mod(l * (p.x - x) - p.y) };
};
/** k·G by double-and-add. */
export const p256PublicPoint = (k: bigint): { x: bigint; y: bigint } => {
  let acc: Point = null;
  let base: Point = G;
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) acc = add(acc, base);
    base = add(base, base);
  }
  if (!acc) throw new Error('scalar is a multiple of the group order');
  return acc;
};

const b64u = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes32 = (n: bigint): Uint8Array => Uint8Array.from(n.toString(16).padStart(64, '0').match(/../g)!, (h) => parseInt(h, 16));
const toBigInt = (b: Uint8Array): bigint => BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') || '0'}`);
const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

/**
 * The simulator's wire format (SimPasskeyDevice): `publicKey` is SPKI, `attestation` signs the challenge,
 * an assertion signs authenticatorData || clientDataJSON, signatures are IEEE P1363. Build with
 * `SeededPasskey.fromSeed`.
 */
export class SeededPasskey {
  readonly credentialId: string;
  readonly origin: string;
  private readonly key: CryptoKey;
  private readonly publicKey: string;
  private counter = 0;

  private constructor(credentialId: string, key: CryptoKey, publicKey: string, origin: string) {
    this.credentialId = credentialId;
    this.key = key;
    this.publicKey = publicKey;
    this.origin = origin;
  }

  static async fromSeed(seed: string, origin = 'https://kesher.example'): Promise<SeededPasskey> {
    // A SHA-256 digest is a valid scalar but for a chance of 2^-32; rehash in that case.
    let d = await sha256(utf8(`kesher-demo-passkey:${seed}`));
    while (toBigInt(d) === 0n || toBigInt(d) >= N) d = await sha256(d);
    const { x, y } = p256PublicPoint(toBigInt(d));
    const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64u(bytes32(x)), y: b64u(bytes32(y)) };
    const key = await crypto.subtle.importKey('jwk', { ...jwk, d: b64u(d) }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pub));
    const credentialId = b64u((await sha256(utf8(`kesher-demo-credential:${seed}`))).subarray(0, 16));
    return new SeededPasskey(credentialId, key, b64u(spki), origin);
  }

  async register(options: PasskeyRegistrationOptions): Promise<PasskeyRegistrationResponse> {
    return { credentialId: this.credentialId, publicKey: this.publicKey, clientDataJSON: this.clientData(options.challenge, 'webauthn.create'), attestation: await this.sign(utf8(options.challenge)), transports: ['internal'] };
  }

  /**
   * The server keeps the last counter and refuses one that does not grow. A derived key has no memory
   * between runs, so the counter follows the wall clock: a fresh process starts above the last one's.
   */
  async authenticate(options: PasskeyAuthenticationOptions): Promise<PasskeyAuthenticationResponse> {
    this.counter = Math.max(this.counter + 1, Date.now());
    const clientDataJSON = this.clientData(options.challenge, 'webauthn.get');
    const authenticatorData = b64u(utf8(`${options.rpId}|uv|${this.counter}`));
    const signature = await this.sign(new Uint8Array([...fromB64u(authenticatorData), ...utf8(clientDataJSON)]));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData, signature, counter: this.counter };
  }

  private async sign(data: Uint8Array): Promise<string> {
    return b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key, data)));
  }

  private clientData(challenge: string, type: string): string {
    return b64u(utf8(JSON.stringify({ type, challenge, origin: this.origin })));
  }
}

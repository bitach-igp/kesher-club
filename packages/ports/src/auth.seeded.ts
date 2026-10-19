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
const G = { x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n };

const mod = (a: bigint): bigint => ((a % P) + P) % P;
const inv = (a: bigint): bigint => {
  let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0);
};

// Jacobian coordinates (x = X/Z², y = Y/Z³): one inversion per multiplication instead of one per step.
type Jacobian = { X: bigint; Y: bigint; Z: bigint };
const INFINITY: Jacobian = { X: 0n, Y: 1n, Z: 0n };
const double = ({ X, Y, Z }: Jacobian): Jacobian => {
  if (Z === 0n || Y === 0n) return INFINITY;
  const yy = mod(Y * Y);
  const s = mod(4n * X * yy);
  const zz = mod(Z * Z);
  const m = mod(3n * (X - zz) * (X + zz)); // a = -3
  const x3 = mod(m * m - 2n * s);
  return { X: x3, Y: mod(m * (s - x3) - 8n * yy * yy), Z: mod(2n * Y * Z) };
};
const add = (p: Jacobian, q: Jacobian): Jacobian => {
  if (p.Z === 0n) return q;
  if (q.Z === 0n) return p;
  const z1z1 = mod(p.Z * p.Z);
  const z2z2 = mod(q.Z * q.Z);
  const u1 = mod(p.X * z2z2);
  const u2 = mod(q.X * z1z1);
  const s1 = mod(p.Y * q.Z * z2z2);
  const s2 = mod(q.Y * p.Z * z1z1);
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const v = mod(u1 * hh);
  const x3 = mod(r * r - hhh - 2n * v);
  return { X: x3, Y: mod(r * (v - x3) - s1 * hhh), Z: mod(h * p.Z * q.Z) };
};
/** k·G by double-and-add. */
export const p256PublicPoint = (k: bigint): { x: bigint; y: bigint } => {
  let acc = INFINITY;
  let base: Jacobian = { X: G.x, Y: G.y, Z: 1n };
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) acc = add(acc, base);
    base = double(base);
  }
  if (acc.Z === 0n) throw new Error('scalar is a multiple of the group order');
  const zi = inv(acc.Z);
  const zi2 = mod(zi * zi);
  return { x: mod(acc.X * zi2), y: mod(acc.Y * zi2 * zi) };
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

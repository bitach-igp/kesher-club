// The demo's people (T-0032): who the eighteen money flows in docs/bank-review/money-flows.md start from,
// and a passkey each can sign in with on every run. Names and phones are fictional: phones sit in the
// reserved 555-01xx range. A persona's key derives everything else (device id, passkey, idempotency keys),
// so a second seed run finds the first run's people instead of making new ones.
import { createECDH, createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import type { PasskeyAuthenticationOptions, PasskeyAuthenticationResponse, PasskeyRegistrationOptions, PasskeyRegistrationResponse } from '@kesher/ports';

export type Market = 'US' | 'IL';
export type Currency = 'USD' | 'ILS';

export interface Persona {
  /** Stable key: device id, passkey and idempotency keys derive from it. */
  key: string;
  name: string;
  /** E.164, in the fictional 555-01xx range. */
  phone: string;
  /** The market whose walkthroughs use this persona. The party itself has no market: every member holds both purses. */
  market: Market;
  /** T2 also issues the virtual card (card.virtual is on in the demo). */
  kyc: 'T1' | 'T2';
  /** Card loads (fixture pm_ok, settled at once) that fund the purses, in minor units. */
  loads: readonly { currency: Currency; minor: bigint }[];
  /** The recordings (docs/bank-review/README.md) that start from this persona. */
  recs: readonly string[];
  role: string;
}

export const PERSONAS: readonly Persona[] = [
  { key: 'dana', name: 'Dana Example', phone: '+15555550101', market: 'US', kyc: 'T2', loads: [{ currency: 'USD', minor: 50_000n }], recs: ['REC-01', 'REC-02', 'REC-04', 'REC-05', 'REC-07', 'REC-09', 'REC-16'], role: 'US member, sender' },
  { key: 'avi', name: 'Avi Example', phone: '+15555550102', market: 'US', kyc: 'T1', loads: [], recs: ['REC-05', 'REC-08'], role: 'US member, Dana pays him' },
  { key: 'noa', name: 'Noa Example', phone: '+15555550103', market: 'IL', kyc: 'T2', loads: [{ currency: 'ILS', minor: 500_000n }, { currency: 'USD', minor: 10_000n }], recs: ['REC-03', 'REC-07', 'REC-08', 'REC-10', 'REC-13'], role: 'IL member, both purses' },
  { key: 'maya', name: 'Maya Example', phone: '+15555550104', market: 'IL', kyc: 'T1', loads: [{ currency: 'ILS', minor: 100_000n }], recs: ['REC-06'], role: 'new pair, sender' },
  { key: 'eli', name: 'Eli Example', phone: '+15555550105', market: 'IL', kyc: 'T1', loads: [], recs: ['REC-06'], role: 'new pair, recipient; has never been paid by Maya' },
  { key: 'tamar', name: 'Tamar Example', phone: '+15555550106', market: 'US', kyc: 'T2', loads: [{ currency: 'USD', minor: 20_000n }], recs: ['REC-12'], role: 'member with an open virtual card' },
  { key: 'ruth', name: 'Ruth Example', phone: '+15555550107', market: 'US', kyc: 'T1', loads: [{ currency: 'USD', minor: 3_000n }], recs: ['REC-17'], role: 'ready to close: card-loaded money only, no holds' },
  { key: 'ben', name: 'Ben Example', phone: '+15555550108', market: 'US', kyc: 'T1', loads: [], recs: ['REC-01'], role: 'funder; the link to a member is missing (see docs/setup/demo.md)' },
];

/** Personas the contract cannot make yet. Listed, never created through SQL. */
export const MISSING: readonly { who: string; recs: readonly string[]; why: string }[] = [
  { who: 'Funder linked to a member (Ben to Dana)', recs: ['REC-01', 'REC-04'], why: 'POST /memberships needs a plan in billing.plan_version, and no endpoint or migration creates one' },
  { who: 'Institution with a roster', recs: ['REC-14', 'REC-15'], why: 'no endpoint creates org.institution; a roster import only makes invited members, and nothing over HTTP activates them' },
  { who: 'Finance requester and second approver', recs: ['REC-14'], why: 'no endpoint creates org.staff or grants the org_finance role; sign-up always gives the member role' },
  { who: 'Allowance schedule', recs: ['REC-14'], why: 'no endpoint creates org.allowance_schedule' },
];

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * A passkey whose ES256 key derives from a seed, in the simulator's wire format (SimPasskeyDevice in
 * @kesher/ports): the same persona has the same credential on every run, in every process. Simulator only:
 * anyone holding the seed can sign, which is the point for a demo and why the RP is `kesher.example`.
 */
export class SeededPasskey {
  readonly credentialId: string;
  readonly origin: string;
  private readonly key: KeyObject;
  private readonly publicKey: string;
  private counter = 0;

  constructor(seed: string, origin = 'https://kesher.example') {
    this.origin = origin;
    this.credentialId = b64u(sha256(`kesher-demo-credential:${seed}`).subarray(0, 16));
    const ecdh = createECDH('prime256v1');
    // A SHA-256 digest is a valid P-256 scalar but for a chance of 2^-32; rehash in that case.
    for (let d = sha256(`kesher-demo-passkey:${seed}`); ; d = createHash('sha256').update(d).digest()) {
      try {
        ecdh.setPrivateKey(d);
        break;
      } catch {
        continue;
      }
    }
    const point = ecdh.getPublicKey(); // 0x04 || x || y
    this.key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64u(ecdh.getPrivateKey()), x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) } });
    this.publicKey = b64u(createPublicKey(this.key).export({ type: 'spki', format: 'der' }));
  }

  register(options: PasskeyRegistrationOptions): PasskeyRegistrationResponse {
    return { credentialId: this.credentialId, publicKey: this.publicKey, clientDataJSON: this.clientData(options.challenge, 'webauthn.create'), attestation: this.sign(utf8(options.challenge)), transports: ['internal'] };
  }

  /**
   * The server keeps the last counter and refuses one that does not grow. A derived key has no memory
   * between runs, so the counter follows the wall clock: a fresh process starts above the last one's.
   */
  authenticate(options: PasskeyAuthenticationOptions): PasskeyAuthenticationResponse {
    this.counter = Math.max(this.counter + 1, Date.now());
    const clientDataJSON = this.clientData(options.challenge, 'webauthn.get');
    const authenticatorData = b64u(utf8(`${options.rpId}|uv|${this.counter}`));
    const signature = this.sign(new Uint8Array([...Buffer.from(authenticatorData, 'base64url'), ...utf8(clientDataJSON)]));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData, signature, counter: this.counter };
  }

  private sign(data: Uint8Array): string {
    return b64u(sign('sha256', data, { key: this.key, dsaEncoding: 'ieee-p1363' }));
  }

  private clientData(challenge: string, type: string): string {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin })).toString('base64url');
  }
}

export const deviceIdOf = (p: Persona): string => `demo-${p.key}`;

// One device per persona per process, so assertions made within the same millisecond still count up.
const devices = new Map<string, SeededPasskey>();
export const passkeyOf = (p: Persona): SeededPasskey => devices.get(p.key) ?? devices.set(p.key, new SeededPasskey(p.key)).get(p.key)!;

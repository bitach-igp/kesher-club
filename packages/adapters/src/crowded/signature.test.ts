// TST-INS-025 (REQ-INS-025) at the verifier: a correct signature over the raw bytes passes, the same payload re-serialised with other
// whitespace fails, a missing, malformed or sha1= header fails, either of two rotation secrets passes, and with no secret nothing does.
import { describe, expect, it } from 'vitest';
import { computeCrowdedSignature, headerValue, verifyCrowdedSignature } from './signature.ts';

const SECRET = 'crowded_endpoint_secret_0123456789abcdef';
const PREVIOUS = 'crowded_previous_secret_0123456789abcdef';
const body = JSON.stringify({ batchId: 'b1', count: 1, events: [{ eventId: 'e1', eventType: 'finance.application.approved' }] });

describe('Crowded webhook signature', () => {
  it('a correct signature over the raw bytes passes, whatever the secret slot', () => {
    const header = computeCrowdedSignature(SECRET, body);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyCrowdedSignature({ header, rawBody: body, secrets: [SECRET] })).toBeUndefined();
    expect(verifyCrowdedSignature({ header, rawBody: body, secrets: [PREVIOUS, SECRET] })).toBeUndefined();
    expect(verifyCrowdedSignature({ header: computeCrowdedSignature(PREVIOUS, body), rawBody: body, secrets: [SECRET, PREVIOUS] })).toBeUndefined();
    expect(verifyCrowdedSignature({ header, rawBody: Buffer.from(body), secrets: [SECRET] })).toBeUndefined();
  });

  it('the same payload re-serialised with other whitespace fails: the raw bytes are what is signed', () => {
    const header = computeCrowdedSignature(SECRET, body);
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyCrowdedSignature({ header, rawBody: pretty, secrets: [SECRET] })).toBe('MISMATCH');
    expect(verifyCrowdedSignature({ header, rawBody: ` ${body}`, secrets: [SECRET] })).toBe('MISMATCH');
  });

  it('a missing, empty, malformed or sha1= header fails', () => {
    const good = computeCrowdedSignature(SECRET, body);
    expect(verifyCrowdedSignature({ header: undefined, rawBody: body, secrets: [SECRET] })).toBe('NO_SIGNATURE');
    expect(verifyCrowdedSignature({ header: '  ', rawBody: body, secrets: [SECRET] })).toBe('NO_SIGNATURE');
    expect(verifyCrowdedSignature({ header: good.replace('sha256=', 'sha1='), rawBody: body, secrets: [SECRET] })).toBe('MALFORMED');
    expect(verifyCrowdedSignature({ header: good.slice('sha256='.length), rawBody: body, secrets: [SECRET] })).toBe('MALFORMED');
    expect(verifyCrowdedSignature({ header: good.slice(0, -2), rawBody: body, secrets: [SECRET] })).toBe('MALFORMED');
    expect(verifyCrowdedSignature({ header: `${good}00`, rawBody: body, secrets: [SECRET] })).toBe('MALFORMED');
  });

  it('a wrong secret or a changed body fails; with no secret configured nothing verifies', () => {
    const header = computeCrowdedSignature(SECRET, body);
    expect(verifyCrowdedSignature({ header, rawBody: body, secrets: [PREVIOUS] })).toBe('MISMATCH');
    expect(verifyCrowdedSignature({ header, rawBody: body.replace('e1', 'e2'), secrets: [SECRET] })).toBe('MISMATCH');
    expect(verifyCrowdedSignature({ header, rawBody: body, secrets: [] })).toBe('MISMATCH');
    expect(verifyCrowdedSignature({ header: computeCrowdedSignature('', body), rawBody: body, secrets: [''] })).toBe('MISMATCH');
  });

  it('finds the header whatever its case', () => {
    expect(headerValue({ 'X-Webhook-Signature': 'sha256=x' }, 'x-webhook-signature')).toBe('sha256=x');
    expect(headerValue({}, 'x-webhook-signature')).toBeUndefined();
  });
});

// Fixed vectors. Computed OUTSIDE this code base with node's crypto and (cross-checked) with openssl, from Crowded's documented header
// (docs/vendors/crowded/api-inventory.md section 5.2; postman export "Signature Verification"): `X-Webhook-Signature: sha256=<hex>`,
// HMAC-SHA256 of the RAW request body keyed by the webhook secret; no timestamp.
// Recompute:
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac crowded_vec_secret_A -hex
//   node -e "console.log(require('crypto').createHmac('sha256','crowded_vec_secret_A').update(BODY).digest('hex'))"
// They do not call computeCrowdedSignature, so a change to what is signed fails here.
describe('Crowded webhook signature fixed vectors', () => {
  const A = 'crowded_vec_secret_A';
  const B = 'crowded_vec_secret_B';
  const vBody = '{"batchId":"b_vec_1","count":1,"events":[{"eventId":"e_vec_1","eventType":"finance.application.approved"}]}';
  const HEX_A = 'bfaa600b472b54a0a98f464c4733fbd1dacc219d38999404960a6eeb99a1bd0c'; // HMAC(A, vBody)
  const HEX_B = 'b7a38f1ecb6824867c7dbf5500878fac6c93cf25bcc1b206915ca4a170ff5669'; // HMAC(B, vBody)
  const v = (header: string | undefined, secrets: readonly string[], rawBody: string | Uint8Array = vBody) =>
    verifyCrowdedSignature({ header, rawBody, secrets });

  it('accepts the vector (string and byte bodies), in any case of the hex', () => {
    expect(v(`sha256=${HEX_A}`, [A])).toBeUndefined();
    expect(v(`sha256=${HEX_A}`, [A], new TextEncoder().encode(vBody))).toBeUndefined();
    expect(v(`sha256=${HEX_A.toUpperCase()}`, [A])).toBeUndefined();
    expect(v(`  sha256=${HEX_A} `, [A])).toBeUndefined();
  });

  it('refuses the wrong key, a changed byte, and a different slice of the body', () => {
    expect(v(`sha256=${HEX_A}`, [B])).toBe('MISMATCH');
    expect(v(`sha256=${HEX_A}`, [A], vBody.replace('e_vec_1', 'e_vec_2'))).toBe('MISMATCH');
    expect(v(`sha256=${HEX_A}`, [A], vBody.slice(0, -1))).toBe('MISMATCH');
    expect(v(`sha256=${HEX_A}`, [A], `${vBody}\n`)).toBe('MISMATCH');
  });

  it('refuses empty, whitespace and malformed headers', () => {
    expect(v(undefined, [A])).toBe('NO_SIGNATURE');
    expect(v('', [A])).toBe('NO_SIGNATURE');
    expect(v('   ', [A])).toBe('NO_SIGNATURE');
    expect(v(HEX_A, [A])).toBe('MALFORMED');
    expect(v('sha256=', [A])).toBe('MALFORMED');
    expect(v(`sha1=${HEX_A}`, [A])).toBe('MALFORMED');
    expect(v(`sha256=${HEX_A.slice(2)}`, [A])).toBe('MALFORMED');
    expect(v(`sha256=${HEX_A}ab`, [A])).toBe('MALFORMED');
    expect(v(`sha256=${'z'.repeat(64)}`, [A])).toBe('MALFORMED');
  });

  it('accepts a second secret (rotation), in either slot', () => {
    expect(v(`sha256=${HEX_B}`, [A, B])).toBeUndefined();
    expect(v(`sha256=${HEX_B}`, [B, A])).toBeUndefined();
    expect(v(`sha256=${HEX_A}`, [A, B])).toBeUndefined();
    expect(v(`sha256=${HEX_A}`, [B, A])).toBeUndefined();
    expect(v(`sha256=${HEX_B}`, [A])).toBe('MISMATCH');
  });

  it('an empty secret is skipped without ending the loop, and never verifies anything', () => {
    expect(v(`sha256=${HEX_A}`, ['', A])).toBeUndefined();
    expect(v(`sha256=${HEX_A}`, [A, ''])).toBeUndefined();
    expect(v(`sha256=${HEX_B}`, ['', A, B])).toBeUndefined();
    expect(v(`sha256=${HEX_A}`, [''])).toBe('MISMATCH');
    expect(v(`sha256=${HEX_A}`, [])).toBe('MISMATCH');
    // HMAC-SHA256 keyed by the empty string (openssl dgst -sha256 -hmac '' -hex): a signature anyone can forge, so it must never verify.
    const emptyKeySig = 'db20bc8bee26c49d274aeb17a62794c05d84ffcc356d7c7e8c736148834d2929';
    expect(v(`sha256=${emptyKeySig}`, [''])).toBe('MISMATCH');
    expect(v(`sha256=${emptyKeySig}`, ['', A])).toBe('MISMATCH');
  });
});

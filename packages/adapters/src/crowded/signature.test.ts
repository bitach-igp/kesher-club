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

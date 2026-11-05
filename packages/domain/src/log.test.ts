// T-0052: the logger. Redaction is by construction: a fixed field list, scrubbed text, strict identifiers.
import { describe, expect, it } from 'vitest';
import { createLogger, scrub } from './log.ts';

const capture = (market?: string) => {
  const lines: string[] = [];
  const log = createLogger({ service: 'api', ...(market ? { market } : {}), write: (l) => lines.push(l), now: () => new Date('2026-11-05T12:00:00Z') });
  return { log, lines, last: () => JSON.parse(lines.at(-1)!) as Record<string, unknown> };
};

describe('createLogger', () => {
  it('writes one JSON line with the time, level, service, market and event', () => {
    const { log, last, lines } = capture('IL');
    log('request', { requestId: 'req-12345678', method: 'GET', route: 'getStatus', status: 200, durationMs: 12 });
    expect(lines).toHaveLength(1);
    expect(last()).toEqual({ at: '2026-11-05T12:00:00.000Z', level: 'info', service: 'api', market: 'IL', event: 'request', requestId: 'req-12345678', method: 'GET', route: 'getStatus', status: 200, durationMs: 12 });
  });

  it('levels: *_failed and any error field are errors, warning and *_timeout are warnings, the rest info', () => {
    const { log, last } = capture();
    log('job_failed', { job: 'sweep' });
    expect(last()['level']).toBe('error');
    log('listening', { error: 'Boom' });
    expect(last()['level']).toBe('error');
    log('warning', { message: 'careful' });
    expect(last()['level']).toBe('warning');
    log('drain_timeout', { drainMs: 1000 });
    expect(last()['level']).toBe('warning');
    log('started');
    expect(last()['level']).toBe('info');
  });

  it('drops any field outside the list and records only its name', () => {
    const { log, last, lines } = capture();
    log('request', { status: 200, ...({ body: { pan: '4242424242424242' }, headers: 'Bearer abc.def.ghi', member: 'Dana Levi' } as object) });
    expect(last()['dropped']).toEqual(['body', 'headers', 'member']);
    expect(last()).not.toHaveProperty('body');
    expect(lines.join()).not.toMatch(/4242|Dana|Bearer/);
  });

  it('never prints card numbers, CVV-length numbers, OTPs, tokens, e-mail or long secrets through any text field', () => {
    const secrets = [
      '4242 4242 4242 4242',
      '4242-4242-4242-4242',
      '4242424242424242',
      '123456',
      'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl',
      'Bearer abcdefghijklmnop',
      'dana.levi@example.com',
      'a'.repeat(40),
      'deadbeef'.repeat(8),
      'c2VjcmV0LWtleS1tYXRlcmlhbC10aGF0LWlzLWxvbmc=',
    ];
    for (const field of ['message', 'error', 'route', 'job', 'code', 'signal', 'mode', 'method'] as const) {
      for (const secret of secrets) {
        const { log, lines } = capture();
        log('probe', { [field]: `before ${secret} after` });
        const out = lines.join();
        expect(out, `${field}: ${secret}`).not.toContain(secret);
        expect(out, `${field}: ${secret}`).not.toMatch(/4242|dana\.levi|eyJhbG|abcdefghijklmnop|deadbeef|c2VjcmV0/);
      }
    }
  });

  it('echoes an identifier only in its strict shape', () => {
    const { log, last } = capture();
    log('request', { requestId: '0190f3c2-7a1b-7c3d-8e4f-0123456789ab', traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
    expect(last()).toMatchObject({ requestId: '0190f3c2-7a1b-7c3d-8e4f-0123456789ab', traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
    log('request', { requestId: 'a b; drop table', traceId: '4242 4242 4242 4242' });
    expect(last()).toMatchObject({ requestId: '[invalid]', traceId: '[invalid]' });
  });

  it('numbers must be numbers; the provider map carries port and adapter names only; an odd event name is not echoed', () => {
    const { log, last } = capture();
    log('x', { status: Number.NaN, ms: 5 });
    expect(last()).toMatchObject({ status: '[invalid]', ms: 5 });
    log('listening', { providers: { 'institution-banking': 'crowded', 'bad key!': 'tok_live_abc def' } });
    expect(last()['providers']).toEqual({ 'institution-banking': 'crowded', '[invalid]': '[invalid]' });
    log('has a space 4242424242424242');
    expect(last()['event']).toBe('[invalid]');
  });

  it('truncates a long message', () => {
    const { log, last } = capture();
    log('warning', { message: 'x '.repeat(600) });
    expect(String(last()['message']).length).toBeLessThanOrEqual(501);
  });
});

describe('scrub', () => {
  it('leaves ordinary text alone', () => {
    expect(scrub('Missing configuration: DATABASE_URL, JWT_SIGNING_KEY')).toBe('Missing configuration: DATABASE_URL, JWT_SIGNING_KEY');
    expect(scrub('listening in 12 ms')).toBe('listening in 12 ms');
  });

  it('masks any 4 to 8 digit number in text: an OTP cannot be told from another number, so numbers belong in the numeric fields', () => {
    expect(scrub('listening on port 3000')).toBe('listening on port [digits]');
  });
});

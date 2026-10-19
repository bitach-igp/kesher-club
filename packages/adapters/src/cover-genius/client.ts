// XCover (Cover Genius) Partner API transport. Auth is XCover's HTTP Signature scheme:
//   Date: <RFC 7231 date>
//   Authorization: Signature keyId="<apiKey>",algorithm="hmac-sha1",signature="<base64 HMAC-SHA1(secret, `date: <Date>`)>"
// JSON in, JSON out, no retries. The API secret lives in a closure and never appears in errors.
import { createHmac } from 'node:crypto';
import type { Clock } from '@kesher/ports';

export interface XCoverClientOptions {
  /** Partner code in the URL path, e.g. KESHER. */
  partnerCode: string;
  apiKey: string;
  apiSecret: string;
  /** https://api.sandbox.xcover.com (sandbox) / https://api.xcover.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
}

export class XCoverApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(
    status: number,
    body: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'XCoverApiError';
  }
  get isOutage(): boolean {
    return this.status >= 500 || this.status === 429;
  }
  /** True when any string in the error body mentions the word (e.g. "expired"). */
  mentions(word: RegExp): boolean {
    return word.test(JSON.stringify(this.body));
  }
}

export class XCoverTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XCoverTransportError';
  }
}

export function xcoverSignature(apiSecret: string, dateHeader: string): string {
  return createHmac('sha1', apiSecret).update(`date: ${dateHeader}`, 'utf8').digest('base64');
}

export function xcoverAuthorization(apiKey: string, apiSecret: string, dateHeader: string): string {
  return `Signature keyId="${apiKey}",algorithm="hmac-sha1",signature="${xcoverSignature(apiSecret, dateHeader)}"`;
}

export class XCoverClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(opts: XCoverClientOptions) {
    if (!opts.partnerCode || !opts.apiKey || !opts.apiSecret) throw new Error('XCoverClient: partnerCode, apiKey and apiSecret are required');
    this.base = `${(opts.baseUrl ?? 'https://api.xcover.com').replace(/\/$/, '')}/x/partners/${encodeURIComponent(opts.partnerCode)}`;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
  }

  get(path: string): Promise<Record<string, unknown>> {
    return this.request('GET', path);
  }
  post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', path, JSON.stringify(body));
  }

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<Record<string, unknown>> {
    const date = this.clock.now().toUTCString();
    const headers: Record<string, string> = {
      accept: 'application/json',
      date,
      'x-api-date': date, // browsers/proxies may strip `Date`; XCover accepts either
      authorization: xcoverAuthorization(this.apiKey, this.apiSecret, date),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new XCoverTransportError(`XCover unreachable (${method} ${path})`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (!res.ok) throw new XCoverApiError(res.status, {}, `XCover error ${res.status}`);
      throw new XCoverTransportError(`XCover returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const rec = isRecord(json) ? json : {};
      const message = str(rec['message']) ?? str(rec['detail']) ?? `XCover error ${res.status}`;
      throw new XCoverApiError(res.status, rec, message);
    }
    if (!isRecord(json)) throw new XCoverTransportError('XCover returned a non-object body');
    return json;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

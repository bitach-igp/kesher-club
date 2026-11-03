// Crowded HTTP client (T-0648). Base URL and bearer token are passed in (there is no production default); a 15 s
// timeout; the `data` envelope is unwrapped; lists page with `pagination[limit]` / `pagination[offset]` until the
// total is reached or a page comes back short. No retries here: 429 and 5xx are the calling workflow's to retry.
// The token lives in a closure and is never in an error, a log line or a thrown message.
import { isRecord } from './map.ts';

export const SANDBOX_BASE_URL = 'https://sandbox-api.crowdedfinance.com/api/v1';

export interface CrowdedClientOptions {
  /** e.g. SANDBOX_BASE_URL. Required: there is no production default. */
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Called with the status of a 401 or 403 (a credential problem), so it can be logged. Never given the token. */
  onAuthFailure?: (status: number) => void;
}

/**
 * Crowded's error text is untrusted and can echo what we sent (an account or routing number, an email, a mobile). It ends
 * up in messages that callers log, so long digit runs, emails and phone numbers are masked and the text is cut.
 */
export function redact(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '•••@•••')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '•••')
    .replace(/\d{5,}/g, '•••')
    .slice(0, 200);
}

export class CrowdedApiError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  constructor(status: number, body: unknown) {
    const b = isRecord(body) ? body : {};
    // The provider's message is kept as data (truncated); it is never trusted or interpreted.
    super(typeof b['message'] === 'string' ? redact(b['message']) : `Crowded answered ${status}`);
    this.name = 'CrowdedApiError';
    this.status = status;
    this.type = typeof b['type'] === 'string' ? b['type'] : undefined;
    const code = b['code'] ?? b['errorCode'];
    this.code = typeof code === 'string' ? code : undefined;
    this.requestId = typeof b['requestId'] === 'string' ? b['requestId'] : undefined;
  }
  get isOutage(): boolean {
    return this.status >= 500 || this.status === 429;
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get isMissing(): boolean {
    return this.status === 404;
  }
}

export class CrowdedTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrowdedTransportError';
  }
}

export interface CrowdedResponse {
  status: number;
  data: unknown;
  meta: Record<string, unknown>;
}

export class CrowdedClient {
  private readonly baseUrl: string;
  private readonly authorization: () => string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly onAuthFailure: ((status: number) => void) | undefined;

  constructor(opts: CrowdedClientOptions) {
    if (!/^https:\/\/[^/\s]+/.test(opts.baseUrl)) throw new Error('CrowdedClient needs an https baseUrl');
    if (!opts.token) throw new Error('CrowdedClient needs a token');
    const token = opts.token;
    this.authorization = () => `Bearer ${token}`;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.onAuthFailure = opts.onAuthFailure;
  }

  get(path: string, query: Record<string, string | number | undefined> = {}): Promise<CrowdedResponse> {
    return this.request('GET', path, query);
  }

  /** The body goes inside the `data` envelope, as Crowded's request bodies are. */
  post(path: string, body?: unknown): Promise<CrowdedResponse> {
    return this.request('POST', path, {}, body === undefined ? undefined : { data: body });
  }

  /** Every item of a list, across pages. Stops at `meta.pagination.total`, else at the first short page. */
  async *list(path: string, query: Record<string, string | number | undefined> = {}, limit = 100): AsyncGenerator<unknown> {
    for (let offset = 0; ; ) {
      const r = await this.get(path, { ...query, 'pagination[limit]': limit, 'pagination[offset]': offset });
      const items = Array.isArray(r.data) ? r.data : [];
      yield* items;
      offset += items.length;
      const pg = isRecord(r.meta['pagination']) ? r.meta['pagination'] : undefined;
      const total = pg && typeof pg['total'] === 'number' ? pg['total'] : undefined;
      if (items.length === 0 || (total !== undefined ? offset >= total : items.length < limit)) return;
    }
  }

  private async request(method: string, path: string, query: Record<string, string | number | undefined>, body?: unknown): Promise<CrowdedResponse> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k).replace(/%5B/gi, '[').replace(/%5D/gi, ']')}=${encodeURIComponent(String(v))}`)
      .join('&');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers: { Authorization: this.authorization(), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: globalThis.AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CrowdedTransportError('Crowded could not be reached');
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new CrowdedTransportError('Crowded answered with something that is not JSON');
      }
    }
    if (!res.ok) {
      const err = new CrowdedApiError(res.status, json);
      if (err.isAuth) this.onAuthFailure?.(res.status);
      throw err;
    }
    const env = isRecord(json) ? json : {};
    return { status: res.status, data: 'data' in env ? env['data'] : json, meta: isRecord(env['meta']) ? env['meta'] : {} };
  }
}

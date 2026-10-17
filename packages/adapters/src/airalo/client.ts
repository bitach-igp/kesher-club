// Airalo Partner API transport: client-credentials token (cached until shortly before expiry),
// Bearer auth, JSON replies, no retries. Credentials live in a closure; errors never carry them.
import type { Clock } from '@kesher/ports';

export interface AiraloClientOptions {
  clientId: string;
  clientSecret: string;
  /** e.g. https://sandbox-partners-api.airalo.com (sandbox) / https://partners-api.airalo.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
}

/** A non-2xx reply from Airalo: status, `meta.message` and the per-field `data` errors. */
export class AiraloApiError extends Error {
  constructor(
    readonly status: number,
    readonly fieldErrors: Record<string, string[]>,
    message: string,
  ) {
    super(message);
    this.name = 'AiraloApiError';
  }
  get isOutage(): boolean {
    return this.status >= 500 || this.status === 429;
  }
  hasFieldError(field: string): boolean {
    return field in this.fieldErrors;
  }
}

export class AiraloTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiraloTransportError';
  }
}

const TOKEN_MARGIN_MS = 60_000;

export class AiraloClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(opts: AiraloClientOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error('AiraloClient: clientId and clientSecret are required');
    this.baseUrl = (opts.baseUrl ?? 'https://partners-api.airalo.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
  }

  async get(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(query).toString();
    return this.request('GET', qs ? `${path}?${qs}` : path);
  }

  async post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request('POST', path, new URLSearchParams(form).toString());
  }

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await this.send(method, path, headers, body);
    if (res.status === 401) this.token = undefined; // next call re-authenticates; this one fails
    return res.body;
  }

  private async accessToken(): Promise<string> {
    const now = this.clock.now().getTime();
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > now) return this.token.value;
    const res = await this.send(
      'POST',
      '/v2/token',
      { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }).toString(),
    );
    const data = isRecord(res.body['data']) ? res.body['data'] : {};
    const value = typeof data['access_token'] === 'string' ? data['access_token'] : undefined;
    const expiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : undefined;
    if (!value || expiresIn === undefined) throw new AiraloTransportError('Airalo token reply had no access_token/expires_in');
    this.token = { value, expiresAt: now + expiresIn * 1000 };
    return value;
  }

  private async send(method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new AiraloTransportError(`Airalo unreachable (${method} ${path.split('?')[0]})`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (!res.ok) throw new AiraloApiError(res.status, {}, `Airalo error ${res.status}`);
      throw new AiraloTransportError(`Airalo returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const rec = isRecord(json) ? json : {};
      const meta = isRecord(rec['meta']) ? rec['meta'] : {};
      const fieldErrors: Record<string, string[]> = {};
      if (isRecord(rec['data'])) for (const [k, v] of Object.entries(rec['data'])) if (Array.isArray(v)) fieldErrors[k] = v.filter((x): x is string => typeof x === 'string');
      const message = typeof meta['message'] === 'string' ? meta['message'] : typeof rec['message'] === 'string' ? rec['message'] : `Airalo error ${res.status}`;
      throw new AiraloApiError(res.status, fieldErrors, message);
    }
    if (!isRecord(json)) throw new AiraloTransportError('Airalo returned a non-object body');
    return { status: res.status, body: json };
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);

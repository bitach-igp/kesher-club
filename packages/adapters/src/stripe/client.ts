// Minimal Stripe REST transport: form-encoded requests, Bearer auth, Idempotency-Key, no retries
// (retries belong to the Temporal workflow). Vendor failures become StripeApiError /
// StripeTransportError; the adapters map those to their port's typed errors. The secret key is held
// in a closure and never appears in errors or logs.

export type FormValue = string | bigint | boolean | undefined | FormValue[] | { [k: string]: FormValue };

export interface StripeClientOptions {
  secretKey: string;
  baseUrl?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
}

/** A non-2xx reply from Stripe, with the fields of its `error` object (never the request). */
export class StripeApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | undefined;
  readonly declineCode: string | undefined;
  readonly param: string | undefined;
  constructor(
    status: number,
    type: string,
    code: string | undefined,
    declineCode: string | undefined,
    param: string | undefined,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.declineCode = declineCode;
    this.param = param;
    this.name = 'StripeApiError';
  }
  get isOutage(): boolean {
    return this.status >= 500 || this.status === 429 || this.type === 'api_error';
  }
  get isMissing(): boolean {
    return this.status === 404 || this.code === 'resource_missing';
  }
}

/** Network failure or a reply that is not Stripe JSON. */
export class StripeTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeTransportError';
  }
}

/** Encodes nested params the way Stripe expects: `items[0][price_data][unit_amount]=4900`. */
export function encodeForm(params: { [k: string]: FormValue }): string {
  const out = new URLSearchParams();
  const walk = (key: string, v: FormValue): void => {
    if (v === undefined) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${key}[${i}]`, item));
    else if (typeof v === 'object') for (const [k, inner] of Object.entries(v)) walk(`${key}[${k}]`, inner);
    else out.append(key, typeof v === 'bigint' ? v.toString() : String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.toString();
}

export class StripeClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;

  constructor(opts: StripeClientOptions) {
    if (!opts.secretKey) throw new Error('StripeClient: secretKey is required');
    this.baseUrl = (opts.baseUrl ?? 'https://api.stripe.com').replace(/\/$/, '');
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.authorization = `Bearer ${opts.secretKey}`;
  }

  post(path: string, params: { [k: string]: FormValue }, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.request('POST', path, encodeForm(params), idempotencyKey);
  }
  get(path: string, query: { [k: string]: FormValue } = {}): Promise<Record<string, unknown>> {
    const qs = encodeForm(query);
    return this.request('GET', qs ? `${path}?${qs}` : path);
  }
  delete(path: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', path, undefined, idempotencyKey);
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: this.authorization, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (this.apiVersion) headers['stripe-version'] = this.apiVersion;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new StripeTransportError(`Stripe unreachable (${method} ${path.split('?')[0]})`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new StripeTransportError(`Stripe returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const err = isRecord(json) && isRecord(json['error']) ? json['error'] : {};
      throw new StripeApiError(
        res.status,
        str(err['type']) ?? 'unknown',
        str(err['code']),
        str(err['decline_code']),
        str(err['param']),
        str(err['message']) ?? `Stripe error ${res.status}`,
      );
    }
    if (!isRecord(json)) throw new StripeTransportError('Stripe returned a non-object body');
    return json;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** Stripe integers (amounts, unix timestamps) arrive as JSON numbers; we keep them as bigint. */
export const int = (v: unknown): bigint | undefined => (typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : undefined);
export const unixToIso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();
export const isoToUnix = (d: Date): bigint => BigInt(Math.floor(d.getTime() / 1000));

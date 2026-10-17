// In-memory fake of the XCover Partner API endpoints the adapter calls, in XCover's wire shape:
// JSON bodies, HTTP Signature auth (hmac-sha1 over `date: <Date>`), quote packages keyed by id.
// Policy types (test only): "travel_il_v1" ($12.00/30 d), "gadget_protection" ($4.99/30 d),
// "always_down" -> 503. Unknown policy types -> 400. Control hooks: expireQuote(), outageRequests.
import type { Clock } from '@kesher/ports';
import { xcoverSignature } from './client.ts';

export interface FakeXCoverOptions {
  partnerCode: string;
  apiKey: string;
  apiSecret: string;
  clock?: Clock;
}

export const FAKE_XCOVER_OUTAGE_POLICY_TYPE = 'always_down';

/** Premium per 30 days in minor units; the fake renders it as a decimal string like XCover does. */
const POLICY_TYPES: Record<string, { name: string; per30dMinor: bigint; benefits: string[]; pds: string }> = {
  travel_il_v1: { name: 'Travel Insurance (Israel)', per30dMinor: 1200n, benefits: ['Medical expenses in Israel up to $100,000', 'Trip delay and baggage'], pds: 'https://www.xcover.com/en/pds/fake-travel-il' },
  gadget_protection: { name: 'Gadget Protection', per30dMinor: 499n, benefits: ['Phone and laptop: theft and accidental damage', 'Excess $50'], pds: 'https://www.xcover.com/en/pds/fake-gadget' },
};

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };

interface Booking {
  id: string;
  status: 'QUOTED' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
  quoteId: string;
  policyType: string;
  priceDecimal: string;
  currency: string;
  start: string;
  end: string;
  expiresAt: string;
}

export class FakeXCover {
  readonly fetch: typeof fetch;
  readonly calls: { method: string; path: string; body: Json; signed: boolean }[] = [];
  outageRequests = 0;
  private readonly bookings = new Map<string, Booking>();
  private readonly clock: Clock;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private seq = 0;

  constructor(opts: FakeXCoverOptions) {
    this.base = `/x/partners/${opts.partnerCode}`;
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === 'string' ? init.body : '';
      const reply = this.handle(method, url, headers, raw);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  /** Control hook: XCover's clock ran past the quote's validity. */
  expireQuote(quoteId: string): void {
    const b = this.bookings.get(quoteId);
    if (b) b.status = 'EXPIRED';
  }

  private handle(method: string, url: URL, headers: Headers, raw: string): Reply {
    let body: Json;
    try {
      body = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      return { status: 400, body: { detail: 'JSON parse error' } };
    }
    const signed = this.verify(headers);
    this.calls.push({ method, path: url.pathname, body, signed });
    if (!signed) return { status: 401, body: { detail: 'Invalid signature.' } };
    if (this.outageRequests > 0) {
      this.outageRequests -= 1;
      return { status: 503, body: { detail: 'Service unavailable' } };
    }
    if (!url.pathname.startsWith(this.base + '/')) return { status: 404, body: { detail: 'Not found.' } };
    const path = url.pathname.slice(this.base.length);

    if (method === 'POST' && path === '/quotes/') return this.createQuote(body);
    const booking = /^\/bookings\/([^/]+)\/(cancel\/)?$/.exec(path);
    if (booking) {
      const b = this.bookings.get(decodeURIComponent(booking[1]!));
      if (!b) return { status: 404, body: { detail: 'Not found.' } };
      if (method === 'GET' && !booking[2]) return { status: 200, body: this.json(b) };
      if (method === 'POST' && !booking[2]) return this.confirm(b);
      if (method === 'POST' && booking[2]) return this.cancel(b);
    }
    return { status: 404, body: { detail: 'Not found.' } };
  }

  private verify(headers: Headers): boolean {
    const date = headers.get('date') ?? headers.get('x-api-date');
    const auth = headers.get('authorization') ?? '';
    const m = /^Signature keyId="([^"]+)",algorithm="hmac-sha1",signature="([^"]+)"$/.exec(auth);
    if (!date || !m) return false;
    return m[1] === this.apiKey && m[2] === xcoverSignature(this.apiSecret, date);
  }

  private createQuote(body: Json): Reply {
    const request = Array.isArray(body['request']) ? (body['request'] as Json[]) : [];
    const first = request[0];
    const policyType = typeof first?.['policy_type'] === 'string' ? first['policy_type'] : undefined;
    const currency = typeof body['currency'] === 'string' ? body['currency'] : 'USD';
    if (!policyType) return { status: 400, body: { request: ['This field is required.'] } };
    if (policyType === FAKE_XCOVER_OUTAGE_POLICY_TYPE) return { status: 503, body: { detail: 'Service unavailable' } };
    const def = POLICY_TYPES[policyType];
    if (!def) return { status: 400, body: { request: [{ policy_type: [`"${policyType}" is not a valid choice.`] }] } };
    const start = typeof first?.['policy_start_date'] === 'string' ? first['policy_start_date'] : undefined;
    const end = typeof first?.['policy_end_date'] === 'string' ? first['policy_end_date'] : undefined;
    if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return { status: 400, body: { request: [{ policy_start_date: ['Enter a valid date/time.'] }] } };
    const days = BigInt(Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000)));
    const premiumMinor = (def.per30dMinor * days + 29n) / 30n;
    const n = ++this.seq;
    const b: Booking = {
      id: `${String(n).padStart(4, '0')}-FAKE-INS`,
      status: 'QUOTED',
      quoteId: `q-${n}-${policyType}`,
      policyType,
      priceDecimal: `${premiumMinor / 100n}.${String(premiumMinor % 100n).padStart(2, '0')}`,
      currency,
      start,
      end,
      expiresAt: new Date(this.clock.now().getTime() + 30 * 60_000).toISOString(),
    };
    this.bookings.set(b.id, b);
    return { status: 200, body: this.json(b) };
  }

  private confirm(b: Booking): Reply {
    if (b.status === 'EXPIRED') return { status: 400, body: { quotes: ['Quote package has expired.'] } };
    if (b.status === 'CANCELLED') return { status: 400, body: { detail: 'Booking is cancelled.' } };
    b.status = 'CONFIRMED'; // confirming a confirmed booking is a no-op at XCover too
    return { status: 200, body: this.json(b) };
  }

  private cancel(b: Booking): Reply {
    if (b.status !== 'CONFIRMED') return { status: 400, body: { detail: `Booking cannot be cancelled from status ${b.status}.` } };
    b.status = 'CANCELLED';
    return { status: 200, body: this.json(b) };
  }

  private json(b: Booking): Json {
    const def = POLICY_TYPES[b.policyType]!;
    return {
      id: b.id,
      status: b.status,
      currency: b.currency,
      total_price: Number(b.priceDecimal),
      total_price_formatted: `$${b.priceDecimal}`,
      expires_at: b.expiresAt,
      quotes: {
        [b.quoteId]: {
          id: b.quoteId,
          policy_type: b.policyType,
          policy_name: def.name,
          status: b.status,
          price: Number(b.priceDecimal),
          price_formatted: `$${b.priceDecimal}`,
          policy_start_date: b.start,
          policy_end_date: b.end,
          pds_url: def.pds,
          benefits: def.benefits.map((description) => ({ description })),
          ...(b.status === 'CONFIRMED' || b.status === 'CANCELLED' ? { policy_number: `PN-${b.id}` } : {}),
        },
      },
      ...(b.status === 'CONFIRMED' || b.status === 'CANCELLED' ? { pdf_url: `https://www.xcover.com/en/fake/certificate/${b.id}.pdf` } : {}),
    };
  }
}

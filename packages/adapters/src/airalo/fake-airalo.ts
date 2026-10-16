// In-memory fake of the Airalo Partner API v2 endpoints the adapter calls, in Airalo's wire shape
// (`{ data, meta }` envelopes, form-encoded requests, Bearer tokens from /v2/token).
// Fixtures (test only): package "israel-fail-1gb" -> 503 on order; unknown package -> 422 with
// data.package_id; unknown ICCID -> 404. Control hooks: setRemaining(), outageRequests.
import type { Clock } from '@kesher/ports';

export interface FakeAiraloOptions {
  clientId: string;
  clientSecret: string;
  clock?: Clock;
}

export const FAKE_AIRALO_FAILING_SKU = 'israel-fail-1gb';

interface Pkg {
  id: string;
  country: string;
  title: string;
  dataMb: number; // Airalo's `amount` field: data volume in MB (not money)
  day: number;
  price: string; // decimal USD as Airalo renders it; parsed by the adapter, never arithmetic here
}

const CATALOGUE: Pkg[] = [
  { id: 'israel-7days-1gb', country: 'IL', title: '1 GB - 7 Days', dataMb: 1024, day: 7, price: '4.5' },
  { id: 'israel-15days-3gb', country: 'IL', title: '3 GB - 15 Days', dataMb: 3072, day: 15, price: '11' },
  { id: 'israel-30days-10gb', country: 'IL', title: '10 GB - 30 Days', dataMb: 10240, day: 30, price: '26.5' },
  { id: 'israel-30days-unlimited', country: 'IL', title: 'Unlimited - 30 Days', dataMb: 0, day: 30, price: '45' },
  { id: FAKE_AIRALO_FAILING_SKU, country: 'IL', title: '1 GB - 7 Days (always fails)', dataMb: 1024, day: 7, price: '1' },
  { id: 'united-states-7days-1gb', country: 'US', title: '1 GB - 7 Days', dataMb: 1024, day: 7, price: '4.5' },
];

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };

export class FakeAiralo {
  readonly fetch: typeof fetch;
  readonly calls: { method: string; path: string; form: Record<string, string> }[] = [];
  outageRequests = 0;
  private readonly tokens = new Set<string>();
  private readonly sims = new Map<string, { remaining: number; total: number; expiredAt: string }>();
  private readonly clock: Clock;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private seq = 0;
  tokenRequests = 0;

  constructor(opts: FakeAiraloOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : '';
      const reply = this.handle(method, url, headers, body);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  /** Control hook: push usage so low-data alerts can be exercised. */
  setRemaining(iccid: string, remainingMb: number): void {
    const s = this.sims.get(iccid);
    if (s) s.remaining = remainingMb;
  }

  private handle(method: string, url: URL, headers: Headers, body: string): Reply {
    const form = Object.fromEntries(new URLSearchParams(body));
    this.calls.push({ method, path: url.pathname, form });
    if (this.outageRequests > 0) {
      this.outageRequests -= 1;
      return { status: 503, body: { data: null, meta: { message: 'Service Unavailable' } } };
    }
    if (method === 'POST' && url.pathname === '/v2/token') {
      this.tokenRequests += 1;
      if (form['client_id'] !== this.clientId || form['client_secret'] !== this.clientSecret || form['grant_type'] !== 'client_credentials') {
        return { status: 401, body: { data: null, meta: { message: 'Unauthorized' } } };
      }
      const token = `fake_airalo_token_${++this.seq}`;
      this.tokens.add(token);
      return { status: 200, body: { data: { token_type: 'Bearer', expires_in: 3600, access_token: token }, meta: { message: 'success' } } };
    }
    const auth = headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !this.tokens.has(auth.slice(7))) return { status: 401, body: { message: 'Unauthenticated.' } };

    if (method === 'GET' && url.pathname === '/v2/packages') {
      const country = url.searchParams.get('filter[country]');
      const pkgs = CATALOGUE.filter((p) => !country || p.country === country.toUpperCase());
      const byCountry = new Map<string, Pkg[]>();
      for (const p of pkgs) byCountry.set(p.country, [...(byCountry.get(p.country) ?? []), p]);
      const data = [...byCountry].map(([cc, list]) => ({
        slug: cc === 'IL' ? 'israel' : 'united-states',
        country_code: cc,
        title: cc === 'IL' ? 'Israel' : 'United States',
        operators: [
          {
            id: cc === 'IL' ? 11 : 22,
            title: cc === 'IL' ? 'Israel Mobile' : 'Change',
            type: 'local',
            packages: list.map((p) => ({ id: p.id, type: 'sim', price: Number(p.price), amount: p.dataMb, day: p.day, is_unlimited: p.dataMb === 0, title: p.title, data: p.dataMb === 0 ? 'Unlimited' : `${p.dataMb / 1024} GB` })),
          },
        ],
      }));
      return { status: 200, body: { data, meta: { message: 'success' } } };
    }

    if (method === 'POST' && url.pathname === '/v2/orders') {
      const pkg = CATALOGUE.find((p) => p.id === form['package_id']);
      if (!pkg) return { status: 422, body: { data: { package_id: ['The selected package id is invalid.'] }, meta: { message: 'the parameter is invalid' } } };
      if (pkg.id === FAKE_AIRALO_FAILING_SKU) return { status: 503, body: { data: null, meta: { message: 'Service Unavailable' } } };
      const n = ++this.seq;
      const iccid = `8997200000000${String(n).padStart(6, '0')}`;
      const matchingId = `FAKE-${n}`;
      const smdp = 'fake.smdp.airalo.example';
      const expiredAt = new Date(this.clock.now().getTime() + pkg.day * 86_400_000);
      this.sims.set(iccid, { remaining: pkg.dataMb, total: pkg.dataMb, expiredAt: stamp(expiredAt) });
      return {
        status: 200,
        body: {
          data: {
            id: 100_000 + n,
            code: `ORD-${n}`,
            currency: 'USD',
            package_id: pkg.id,
            quantity: Number(form['quantity'] ?? '1'),
            type: 'sim',
            description: form['description'] ?? null,
            esim_type: 'Prepaid',
            validity: pkg.day,
            package: pkg.title,
            data: `${pkg.dataMb / 1024} GB`,
            price: Number(pkg.price),
            created_at: stamp(this.clock.now()),
            sims: [
              {
                id: 200_000 + n,
                created_at: stamp(this.clock.now()),
                iccid,
                lpa: smdp,
                imsis: null,
                matching_id: matchingId,
                qrcode: `LPA:1$${smdp}$${matchingId}`,
                qrcode_url: `https://sandbox.airalo.example/qr?expires=1&id=${n}`,
                direct_apple_installation_url: `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$${smdp}$${matchingId}`,
              },
            ],
          },
          meta: { message: 'success' },
        },
      };
    }

    if (method === 'POST' && url.pathname === '/v2/orders/topups') {
      const pkg = CATALOGUE.find((p) => p.id === form['package_id']);
      const sim = this.sims.get(form['iccid'] ?? '');
      const errors: Record<string, string[]> = {};
      if (!pkg) errors['package_id'] = ['The selected package id is invalid.'];
      if (!sim) errors['iccid'] = ['The selected iccid is invalid.'];
      if (!pkg || !sim) return { status: 422, body: { data: errors, meta: { message: 'the parameter is invalid' } } };
      sim.total += pkg.dataMb;
      sim.remaining += pkg.dataMb;
      const n = ++this.seq;
      return { status: 200, body: { data: { id: 300_000 + n, code: `TOP-${n}`, package_id: pkg.id, currency: 'USD', quantity: 1, type: 'topup', description: form['description'] ?? null, price: Number(pkg.price), created_at: stamp(this.clock.now()) }, meta: { message: 'success' } } };
    }

    const usage = /^\/v2\/sims\/([^/]+)\/usage$/.exec(url.pathname);
    if (method === 'GET' && usage) {
      const sim = this.sims.get(decodeURIComponent(usage[1]!));
      if (!sim) return { status: 404, body: { data: null, meta: { message: 'Sim not found' } } };
      return { status: 200, body: { data: { remaining: sim.remaining, total: sim.total, expired_at: sim.expiredAt, is_unlimited: false, status: 'ACTIVE' }, meta: { message: 'success' } } };
    }

    return { status: 404, body: { message: 'Not Found' } };
  }
}

/** Airalo renders timestamps as "YYYY-MM-DD HH:mm:ss" (UTC). */
const stamp = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

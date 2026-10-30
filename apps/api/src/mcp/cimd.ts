// Client ID Metadata Documents (T-1003, REQ-AGT-003, THR-11, THR-14): a client is its https
// metadata URL. The fetch is SSRF-guarded: https only, no credentials or ports, the host must
// resolve to public addresses only, 5 KB cap, 1 s timeout, redirects refused, cached 24 h.
import { DomainError } from '@kesher/domain';
import type { Database } from '../db.ts';

export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 1000;
export const CIMD_CACHE_MS = 24 * 3_600_000;

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  token_endpoint_auth_method?: string;
}

export type Resolver = (hostname: string) => Promise<string[]>;
export type Fetcher = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** RFC 1918/4193/… ranges plus loopback, link-local, metadata and multicast. Both IPv4 and IPv6. */
export function isPublicAddress(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast + reserved
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return false;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return false; // ULA
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return false; // link-local
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7)); // mapped v4
  if (v6.startsWith('ff')) return false; // multicast
  return /^[0-9a-f:]+$/.test(v6);
}

export class CimdRegistry {
  private readonly db: Database;
  private readonly resolve: Resolver;
  private readonly fetchImpl: Fetcher;
  private readonly clock: () => Date;
  constructor(
    db: Database,
    resolve: Resolver,
    fetchImpl: Fetcher,
    clock: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.resolve = resolve;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  /** Registers (or refreshes) a client from its metadata URL. Refuses anything the guard does not like. */
  async register(clientId: string): Promise<ClientMetadata> {
    const cached = await this.db.query<{ metadata: ClientMetadata; fetched_at: string | Date; status: string }>('select metadata, fetched_at, status from agent.client where client_id = $1', [clientId]);
    const c = cached.rows[0];
    if (c?.status === 'blocked') throw new DomainError('AGENT_NOT_ALLOWED', 'Client is blocked');
    if (c && this.clock().getTime() - new Date(c.fetched_at).getTime() < CIMD_CACHE_MS) return c.metadata;

    const url = this.guardUrl(clientId);
    const addresses = await this.resolve(url.hostname).catch(() => []);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new DomainError('AGENT_NOT_ALLOWED', 'Client metadata host must resolve to public addresses only');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
    let text: string;
    let status: number;
    let contentLength: string | null;
    try {
      const res = await this.fetchImpl(url.href, { signal: controller.signal, redirect: 'manual' });
      status = res.status;
      contentLength = res.headers.get('content-length');
      if (status >= 300 && status < 400) throw new DomainError('AGENT_NOT_ALLOWED', 'Client metadata must not redirect');
      if (status !== 200) throw new DomainError('AGENT_NOT_ALLOWED', `Client metadata fetch returned ${status}`);
      if (contentLength && Number(contentLength) > CIMD_MAX_BYTES) throw new DomainError('AGENT_NOT_ALLOWED', 'Client metadata over 5 KB');
      text = await res.text();
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError('AGENT_NOT_ALLOWED', (e as Error).name === 'AbortError' ? 'Client metadata fetch timed out' : 'Client metadata fetch failed');
    } finally {
      clearTimeout(timer);
    }
    if (Buffer.byteLength(text, 'utf8') > CIMD_MAX_BYTES) throw new DomainError('AGENT_NOT_ALLOWED', 'Client metadata over 5 KB');
    const metadata = parseMetadata(text, clientId);
    await this.db.query(
      `insert into agent.client (client_id, name, metadata, fetched_at) values ($1, $2, $3, $4)
       on conflict (client_id) do update set name = excluded.name, metadata = excluded.metadata, fetched_at = excluded.fetched_at`,
      [clientId, metadata.client_name, JSON.stringify(metadata), this.clock()],
    );
    return metadata;
  }

  async block(clientId: string, reason: string): Promise<void> {
    await this.db.query(`update agent.client set status = 'blocked', blocked_reason = $2 where client_id = $1`, [clientId, reason]);
  }

  private guardUrl(clientId: string): URL {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'client_id must be a URL');
    }
    if (url.protocol !== 'https:') throw new DomainError('AGENT_NOT_ALLOWED', 'client_id must be https');
    if (url.username || url.password) throw new DomainError('AGENT_NOT_ALLOWED', 'client_id must not carry credentials');
    if (url.port && url.port !== '443') throw new DomainError('AGENT_NOT_ALLOWED', 'client_id must use port 443');
    if (url.hash) throw new DomainError('AGENT_NOT_ALLOWED', 'client_id must not have a fragment');
    if (/^(\d+\.){3}\d+$/.test(url.hostname) || url.hostname.startsWith('[')) throw new DomainError('AGENT_NOT_ALLOWED', 'client_id must be a hostname, not an IP');
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) throw new DomainError('AGENT_NOT_ALLOWED', 'client_id host not allowed');
    return url;
  }
}

/**
 * A redirect URI a client may list: https, or http on a loopback host for a native or command-line client
 * (OAuth 2.1 §8.4.2, RFC 8252 §7.3; T-1017). Never a fragment, never credentials.
 */
export function allowedRedirectUri(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}

function parseMetadata(text: string, clientId: string): ClientMetadata {
  let doc: Partial<ClientMetadata>;
  try {
    doc = JSON.parse(text) as Partial<ClientMetadata>;
  } catch {
    throw new DomainError('AGENT_NOT_ALLOWED', 'Client metadata is not JSON');
  }
  if (doc.client_id !== clientId) throw new DomainError('AGENT_NOT_ALLOWED', 'client_id in the document must equal its URL');
  if (!doc.client_name || typeof doc.client_name !== 'string' || doc.client_name.length > 80) throw new DomainError('AGENT_NOT_ALLOWED', 'client_name required (≤ 80 chars)');
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || !doc.redirect_uris.every(allowedRedirectUri)) throw new DomainError('AGENT_NOT_ALLOWED', 'redirect_uris must be https, or http on a loopback host');
  return { client_id: clientId, client_name: doc.client_name, redirect_uris: doc.redirect_uris, ...(doc.client_uri ? { client_uri: doc.client_uri } : {}), ...(doc.logo_uri ? { logo_uri: doc.logo_uri } : {}), ...(doc.scope ? { scope: doc.scope } : {}), ...(doc.token_endpoint_auth_method ? { token_endpoint_auth_method: doc.token_endpoint_auth_method } : {}) };
}

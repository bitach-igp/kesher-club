// VPN allow-list (T-0116, REQ-AUTH-009): pure CIDR matching for IPv4 and IPv6, no I/O.

export interface Cidr {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
  readonly text: string;
}

const V4_BITS = 32;
const V6_BITS = 128;

function parseIpv4(s: string): bigint | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function parseIpv6(s: string): bigint | undefined {
  // Strip a zone id (fe80::1%eth0) and brackets.
  const bare = s.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (bare.length === 0 || bare.includes(':::')) return undefined;
  const halves = bare.split('::');
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? '';
      if (i === items.length - 1 && item.includes('.')) {
        const v4 = parseIpv4(item);
        if (v4 === undefined) return undefined;
        groups.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return undefined;
      groups.push(parseInt(item, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !tail) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  let out = 0n;
  for (const g of groups) out = (out << 16n) | BigInt(g);
  return out;
}

export interface ParsedIp {
  readonly family: 4 | 6;
  readonly value: bigint;
}

/** Parses a textual IP. IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalised to IPv4 so v4 CIDRs match it. */
export function parseIp(text: string): ParsedIp | undefined {
  const s = text.trim();
  if (s.length === 0) return undefined;
  if (!s.includes(':')) {
    const v4 = parseIpv4(s);
    return v4 === undefined ? undefined : { family: 4, value: v4 };
  }
  const v6 = parseIpv6(s);
  if (v6 === undefined) return undefined;
  // ::ffff:a.b.c.d → the high 96 bits are exactly 0x0000_0000_0000_0000_0000_ffff.
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

/** Parses "10.8.0.0/16" or "fd00:1234::/48". A bare address is a /32 or /128. Returns undefined when invalid. */
export function parseCidr(text: string): Cidr | undefined {
  const s = text.trim();
  const slash = s.lastIndexOf('/');
  const ipText = slash === -1 ? s : s.slice(0, slash);
  const ip = parseIp(ipText);
  if (!ip) return undefined;
  const bits = ip.family === 4 ? V4_BITS : V6_BITS;
  let prefix = bits;
  if (slash !== -1) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return undefined;
    prefix = Number(p);
    if (prefix > bits) return undefined;
  }
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { family: ip.family, network: ip.value & mask, prefix, text: s };
}

export function ipInCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.family !== cidr.family) return false;
  const bits = cidr.family === 4 ? V4_BITS : V6_BITS;
  const mask = cidr.prefix === 0 ? 0n : ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(bits - cidr.prefix);
  return (ip.value & mask) === cidr.network;
}

/** True only when the text is a valid IP inside one of the allow-listed CIDRs. Unparseable input is never allowed. */
export function isVpnIp(ipText: string | undefined, cidrs: readonly Cidr[]): boolean {
  if (!ipText) return false;
  const ip = parseIp(ipText);
  if (!ip) return false;
  return cidrs.some((c) => ipInCidr(ip, c));
}

/**
 * The client IP as the load balancer saw it: the first hop of x-forwarded-for, else x-real-ip.
 * Only the first hop is trusted because the ALB appends the true peer there (Tab 3 §9).
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string | undefined {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip')?.trim();
  return real || undefined;
}

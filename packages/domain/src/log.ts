// The one structured logger (T-0052; constitution: never log PAN, CVV, OTPs, tokens or PII). A line is a JSON object on stdout
// that CloudWatch indexes. Redaction is by construction, not by care: the logger takes a fixed list of field names, never an
// arbitrary object, so a caller cannot add `body`, `headers` or `member` and have it printed; a field outside the list is
// dropped and only its NAME is recorded (`dropped`). Free-text values (a message, an error text) are scrubbed of anything shaped
// like a card number, a token, an e-mail address or a long secret before they are written. Identifiers carry a strict shape or
// are replaced. Nothing here knows about members, accounts or transfers: a log line names an event, a route and a duration.

export type LogValue = string | number | boolean;
export type LogLevel = 'info' | 'warning' | 'error';

/** The only fields a line may carry (besides `at`, `level`, `service`, `market` and `event`, which the logger sets). */
const NUMBER_FIELDS = ['status', 'durationMs', 'ms', 'port', 'drainMs', 'jobs'] as const;
const TEXT_FIELDS = ['market', 'route', 'method', 'job', 'error', 'code', 'message', 'signal', 'mode', 'role'] as const;
const ID_FIELDS = ['requestId', 'traceId'] as const;
/** The per-port provider choice: port name to adapter name, both short identifiers. */
const MAP_FIELDS = ['providers'] as const;

export type LogFields = Partial<
  Record<(typeof NUMBER_FIELDS)[number], number> & Record<(typeof TEXT_FIELDS)[number], string> & Record<(typeof ID_FIELDS)[number], string> & Record<(typeof MAP_FIELDS)[number], Record<string, string> | string>
>;

/**
 * A request or trace id: letters, digits and dashes, 8 to 40 characters (a UUID is 36), and not only digits and dashes. Anything
 * else is not echoed.
 */
export const ID_SHAPE = /^(?![\d-]+$)[A-Za-z0-9-]{8,40}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,39}$/i;

const REDACTIONS: readonly [RegExp, string][] = [
  // key=value, key: value and "key":"value" for the names that carry secrets, whatever the value looks like. The name may sit
  // inside a longer one (access_token, client_secret), so only a letter or digit before it stops the match.
  [/(?<![A-Za-z0-9])(token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|auth|credential|otp|pin|cvv|cvc|cookie|session[_-]?id|sessionid|sid)(["']?\s*[=:]\s*)(?:(?:Bearer|Basic|Token)\s+)?("[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1$2[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[token]'], // a JWT
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[token]'],
  [/\b(?:sk|pk|rk|tok|whsec|xox[a-z])_[A-Za-z0-9_]{6,}/gi, '[secret]'], // vendor key prefixes
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?:\p{Nd}[ -]?){12,}\p{Nd}/gu, '[pan]'], // a card number with separators, in any script's digits
  [/\b[A-Fa-f0-9]{32,}\b/g, '[secret]'], // a hex key or digest
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9])/g, '[secret]'], // a long base64 or token-like run
  [/\p{Nd}{4,}/gu, '[digits]'], // an OTP, a PIN, a phone or national id: any run of four or more digits in text
];

/** Scrubs free text, then shortens it: a secret cannot straddle the cut. */
export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

/** A name that is an identifier and survives the scrub unchanged; anything else is not echoed. */
const safeName = (value: unknown): string => (typeof value === 'string' && IDENTIFIER.test(value) && scrub(value) === value ? value : '[invalid]');

export interface Logger {
  (event: string, fields?: LogFields): void;
  readonly service: string;
}

export interface LoggerOptions {
  service: string;
  /** The market of this process, when it has one. */
  market?: string;
  /** The sink; stdout by default. Receives one line without the newline. */
  write?: (line: string) => void;
  now?: () => Date;
}

const LEVEL_OF: Record<string, LogLevel> = {};
const levelFor = (event: string, fields: LogFields): LogLevel => {
  if (LEVEL_OF[event]) return LEVEL_OF[event]!;
  if (event.endsWith('_failed') || event === 'unhandled' || fields.error !== undefined) return 'error';
  if (event === 'warning' || event.endsWith('_timeout')) return 'warning';
  return 'info';
};

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const logger = (event: string, fields: LogFields = {}): void => {
    const line: Record<string, unknown> = {
      at: now().toISOString(),
      level: levelFor(event, fields),
      service: options.service,
      ...(options.market ? { market: options.market } : {}),
      event: safeName(event),
    };
    const dropped: string[] = [];
    for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
      if (value === undefined) continue;
      if ((NUMBER_FIELDS as readonly string[]).includes(name)) {
        line[name] = typeof value === 'number' && Number.isFinite(value) ? value : '[invalid]';
      } else if ((ID_FIELDS as readonly string[]).includes(name)) {
        line[name] = typeof value === 'string' && ID_SHAPE.test(value) ? value : '[invalid]';
      } else if ((TEXT_FIELDS as readonly string[]).includes(name)) {
        line[name] = scrub(String(value));
      } else if ((MAP_FIELDS as readonly string[]).includes(name)) {
        const entries = typeof value === 'object' && value !== null ? Object.entries(value as Record<string, unknown>) : [];
        if (typeof value === 'string') line[name] = scrub(value);
        else line[name] = Object.fromEntries(entries.map(([k, v]) => [safeName(k), safeName(v)]));
      } else {
        dropped.push(name);
      }
    }
    if (dropped.length > 0) line['dropped'] = dropped.map(safeName);
    write(JSON.stringify(line));
  };
  return Object.assign(logger, { service: options.service });
}

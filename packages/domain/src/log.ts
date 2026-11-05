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
const TEXT_FIELDS = ['market', 'route', 'method', 'job', 'error', 'code', 'message', 'signal', 'mode'] as const;
const ID_FIELDS = ['requestId', 'traceId'] as const;
/** The per-port provider choice: port name to adapter name, both short identifiers. */
const MAP_FIELDS = ['providers'] as const;

export type LogFields = Partial<
  Record<(typeof NUMBER_FIELDS)[number], number> & Record<(typeof TEXT_FIELDS)[number], string> & Record<(typeof ID_FIELDS)[number], string> & Record<(typeof MAP_FIELDS)[number], Record<string, string> | string>
>;

/** A request or trace id: hex, letters, digits and dashes only, 8 to 64 characters. Anything else is not echoed. */
export const ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_.-]{0,63}$/i;

const REDACTIONS: readonly [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[token]'], // a JWT
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[pan]'], // a card number, with or without spaces
  [/\b[A-Fa-f0-9]{32,}\b/g, '[secret]'], // a hex key or digest
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9])/g, '[secret]'], // a long base64 or token-like run
  [/\b\d{4,8}\b/g, '[digits]'], // an OTP or a PIN, and any other short number in text
];

/** Scrubs free text. Applied to every string value except identifiers, which are validated instead. */
export function scrub(text: string): string {
  let out = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

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
      event: IDENTIFIER.test(event) ? event : '[invalid]',
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
        else line[name] = Object.fromEntries(entries.map(([k, v]) => [IDENTIFIER.test(k) ? k : '[invalid]', typeof v === 'string' && IDENTIFIER.test(v) ? v : '[invalid]']));
      } else {
        dropped.push(name);
      }
    }
    if (dropped.length > 0) line['dropped'] = dropped.map((n) => (IDENTIFIER.test(n) ? n : '[invalid]'));
    write(JSON.stringify(line));
  };
  return Object.assign(logger, { service: options.service });
}

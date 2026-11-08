// The image scan exception list (T-0049): .github/security/image-scan-ignore.json. A critical finding that
// has a fix fails the release unless a signed, unexpired entry names it. Plain ESM with no dependencies, so the
// release workflow runs it with the Node that is on the runner. Run `node tools/release/check-findings.mjs --help`.

const DAY_MS = 86_400_000;
export const MAX_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REQUIRED = ['id', 'image', 'reason', 'owner', 'signedOn', 'expires'];

/** A YYYY-MM-DD string as UTC midnight milliseconds, or null when it is not a real calendar date. */
export function parseDay(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Every problem in the list, as strings; empty means well formed. Expired entries are checked too: a
 * malformed or over-long entry fails the release even after it has expired, so remove entries once they lapse.
 */
export function validateIgnoreList(doc, today = todayUtc()) {
  const problems = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.entries)) {
    return ['the file must be an object with an "entries" array'];
  }
  const todayMs = parseDay(today);
  doc.entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of REQUIRED) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') problems.push(`${at}.${key} must be a non-empty string`);
    }
    for (const key of Object.keys(entry)) {
      if (!REQUIRED.includes(key)) problems.push(`${at} has an unknown field "${key}"`);
    }
    if (typeof entry.owner === 'string' && entry.owner.trim() !== '' && !OWNER.test(entry.owner)) {
      problems.push(`${at}.owner must be a GitHub handle such as @owner`);
    }
    const signed = parseDay(entry.signedOn);
    const expires = parseDay(entry.expires);
    if (typeof entry.signedOn === 'string' && signed === null) problems.push(`${at}.signedOn must be a date as YYYY-MM-DD`);
    if (typeof entry.expires === 'string' && expires === null) problems.push(`${at}.expires must be a date as YYYY-MM-DD`);
    if (signed !== null && expires !== null) {
      if (expires < signed) problems.push(`${at}.expires is before signedOn`);
      else if ((expires - signed) / DAY_MS > MAX_DAYS) problems.push(`${at} lasts more than ${MAX_DAYS} days (signedOn to expires)`);
      if (todayMs !== null && signed > todayMs) problems.push(`${at}.signedOn is in the future`);
    }
  });
  return problems;
}

/** The entries in force today: expires on or after today, and for this image (`kesher/api`) or `*`. */
export function activeEntries(doc, image, today = todayUtc()) {
  const todayMs = parseDay(today);
  return doc.entries.filter((e) => {
    const expires = parseDay(e.expires);
    return expires !== null && todayMs !== null && expires >= todayMs && (e.image === image || e.image === '*');
  });
}

/** Splits scanner findings (each with an `id`) into those an active entry excuses and those that stay blocking. */
export function applyIgnoreList(doc, image, findings, today = todayUtc()) {
  const ids = new Map(activeEntries(doc, image, today).map((e) => [e.id, e]));
  const ignored = [];
  const blocking = [];
  for (const f of findings) {
    const entry = ids.get(f.id);
    if (entry) ignored.push({ ...f, entry });
    else blocking.push(f);
  }
  return { ignored, blocking };
}

// Release scan gate (T-0049). Usage:
//   node tools/release/check-findings.mjs --ignore <file> [--image kesher/api --findings <file.json>] [--today YYYY-MM-DD]
// Without --findings it only validates the ignore list. With it, the findings (a JSON array of critical findings
// that have a fix, each with an `id`) must all be excused by an unexpired entry, or the exit code is 1.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyIgnoreList, todayUtc, validateIgnoreList } from './ignore-list.mjs';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`bad arguments near "${flag ?? ''}"`);
    out[flag.slice(2)] = value;
  }
  return out;
}

const readJson = (file, what) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${what} ${file}: ${err.message}`, { cause: err });
  }
};

/** Returns { code, lines }; the CLI prints the lines. `::error::` lines are GitHub annotations. */
export function run(args, today = todayUtc()) {
  const lines = [];
  if (!args.ignore) return { code: 2, lines: ['::error::--ignore <file> is required'] };
  const day = args.today ?? today;
  let doc;
  try {
    doc = readJson(args.ignore, 'the ignore list');
  } catch (err) {
    return { code: 1, lines: [`::error::${err.message}`] };
  }
  const problems = validateIgnoreList(doc, day);
  if (problems.length > 0) {
    return { code: 1, lines: problems.map((p) => `::error::${args.ignore}: ${p}`) };
  }
  if (!args.findings) return { code: 0, lines: [`${args.ignore}: ${doc.entries.length} entries, well formed`] };
  if (!args.image) return { code: 2, lines: ['::error::--image is required with --findings'] };
  let findings;
  try {
    findings = readJson(args.findings, 'the findings');
  } catch (err) {
    return { code: 1, lines: [`::error::${err.message}`] };
  }
  if (!Array.isArray(findings) || findings.some((f) => typeof f?.id !== 'string' || f.id === '')) {
    return { code: 1, lines: ['::error::the findings must be an array of objects with an id'] };
  }
  const { ignored, blocking } = applyIgnoreList(doc, args.image, findings, day);
  for (const f of ignored) lines.push(`ignored ${f.id} (${f.entry.owner}, until ${f.entry.expires}): ${f.entry.reason}`);
  for (const f of blocking) {
    lines.push(`::error::${args.image}: critical finding with a fix, no active exception: ${f.id}${f.package ? ` in ${f.package}` : ''}${f.fixedIn ? ` (fixed in ${f.fixedIn})` : ''}`);
  }
  lines.push(`${args.image}: ${findings.length} critical with a fix, ${ignored.length} excused, ${blocking.length} blocking`);
  return { code: blocking.length > 0 ? 1 : 0, lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { code: 2, lines: [`::error::${err.message}`] };
  }
  for (const line of result.lines) console.log(line);
  process.exit(result.code);
}

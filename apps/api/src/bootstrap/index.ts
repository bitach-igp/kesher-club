// One-off production bootstrap (T-0046):
//   node --experimental-strip-types apps/api/src/bootstrap/index.ts --admin-email <addr>
//   pnpm --filter @kesher/api bootstrap --admin-email <addr>
// Reads APP_ENV and DATABASE_URL (PGPASSWORD when the URL carries no password) like the API and crashes when either is missing.
// Prints what it created and what already existed, one JSON line per fact; never a secret, never an unmasked address, and never
// an argument's value (a stray address on the command line must not reach the log).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPgDatabase, type PgDatabase } from '../pg.ts';
import { assertBootstrapEnv, BootstrapError, run } from './bootstrap.ts';

export function parseArgs(argv: readonly string[]): { adminEmail?: string } {
  let adminEmail: string | undefined;
  let seen = false;
  // pnpm 10 forwards the `--` that separates its own flags from the script's; node never sees one otherwise.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = a === '--admin-email' || a.startsWith('--admin-email=');
    if (!flag) throw new BootstrapError(`unknown argument ${i + 1}${a.startsWith('--') ? ` (${a.split('=')[0]})` : ''}`);
    if (seen) throw new BootstrapError('--admin-email was given twice');
    seen = true;
    adminEmail = a === '--admin-email' ? args[++i] : a.slice('--admin-email='.length);
  }
  if (!adminEmail) throw new BootstrapError('--admin-email <address> is required; there is no default');
  return { adminEmail };
}

export interface MainDeps {
  /** Opens the database; injected so a test can prove nothing is opened for a refused run. */
  connect?: (url: string) => PgDatabase;
  out?: (line: string) => void;
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>, deps: MainDeps = {}): Promise<void> {
  const out = deps.out ?? console.log;
  const connect = deps.connect ?? ((url: string) => createPgDatabase(url, { max: 2 }));
  assertBootstrapEnv(env['APP_ENV']); // before the arguments are read and before any connection opens
  const args = parseArgs(argv);
  const url = env['DATABASE_URL'];
  if (!url) throw new BootstrapError('DATABASE_URL is required');
  const db = connect(url);
  try {
    const report = await run(db, { appEnv: env['APP_ENV'], ...(args.adminEmail ? { adminEmail: args.adminEmail } : {}) });
    for (const what of report.created) out(JSON.stringify({ service: 'bootstrap', event: 'created', what }));
    for (const what of report.existing) out(JSON.stringify({ service: 'bootstrap', event: 'existing', what }));
    for (const note of report.notes) out(JSON.stringify({ service: 'bootstrap', event: 'note', note }));
    out(JSON.stringify({ service: 'bootstrap', event: 'done', created: report.created.length, existing: report.existing.length }));
  } finally {
    await db.close();
  }
}

/** What a failure may say: our own messages are safe by construction; anything else is its class and its code (a SQLSTATE or ECONNREFUSED), never its text (a driver error can quote a URL). */
export function describeFailure(e: unknown): { error: string; code?: string; message?: string } {
  if (e instanceof BootstrapError) return { error: e.name, message: e.message };
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return { error: e instanceof Error ? e.name : 'Error', ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}) };
}

/** True when this file is the process entry point; a symlinked path counts, and when it cannot be decided the answer is yes. */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return true;
  }
}

// Run only as the entry point: the strip-only load test imports every module and must not start a bootstrap.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((e: unknown) => {
    console.error(JSON.stringify({ service: 'bootstrap', event: 'failed', ...describeFailure(e) }));
    process.exitCode = 1;
  });
}

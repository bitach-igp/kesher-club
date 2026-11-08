// One-off production bootstrap (T-0046):
//   node --experimental-strip-types apps/api/src/bootstrap/index.ts --admin-email <addr>
// Reads APP_ENV and DATABASE_URL (PGPASSWORD when the URL carries no password) like the API and crashes when either is missing.
// Prints what it created and what already existed, one JSON line per fact; never a secret, never an unmasked address.
import { pathToFileURL } from 'node:url';
import { createPgDatabase } from '../pg.ts';
import { assertBootstrapEnv, BootstrapError, run } from './bootstrap.ts';

export function parseArgs(argv: readonly string[]): { adminEmail?: string } {
  let adminEmail: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--admin-email') adminEmail = argv[++i];
    else if (a.startsWith('--admin-email=')) adminEmail = a.slice('--admin-email='.length);
    else throw new BootstrapError(`unknown argument ${JSON.stringify(a.split('=')[0])}`);
  }
  if (!adminEmail) throw new BootstrapError('--admin-email <address> is required; there is no default');
  return { adminEmail };
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>, out: (line: string) => void = console.log): Promise<void> {
  assertBootstrapEnv(env['APP_ENV']); // before the arguments are read and before any connection opens
  const args = parseArgs(argv);
  const url = env['DATABASE_URL'];
  if (!url) throw new BootstrapError('DATABASE_URL is required');
  const db = createPgDatabase(url, { max: 2 });
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

// Run only as the entry point: the strip-only load test imports every module and must not start a bootstrap.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((e: unknown) => {
    // The message of our own errors is safe by construction; anything else is named by class only (a driver error can quote a URL).
    const message = e instanceof BootstrapError ? e.message : 'unexpected failure';
    console.error(JSON.stringify({ service: 'bootstrap', event: 'failed', error: e instanceof Error ? e.name : 'Error', message }));
    process.exitCode = 1;
  });
}

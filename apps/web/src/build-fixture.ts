// Test support (T-0048): runs the real `next build` of this app against a fixture legal API and returns the static output. Not shipped.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_KEYS } from './legal.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A published version of every kind (both languages), with the given body for `terms`; `omit` leaves kinds out. */
export function fixtureItems(opts: { termsBody?: string; omit?: readonly string[] } = {}): unknown[] {
  return DOC_KEYS.filter((k) => !(opts.omit ?? []).includes(k)).map((k) => ({
    docKey: k,
    version: 3,
    title: { en: `${k} title`, he: `${k} כותרת` },
    body: { en: k === 'terms' ? (opts.termsBody ?? 'Plain terms.') : `Body of ${k}.`, he: `גוף ${k}.` },
    hash: `hash-${k}`,
    material: true,
    effectiveAt: '2026-03-04T10:00:00.000Z',
  }));
}

async function serve(items: unknown[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/v1/legal/documents') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${addr.port}/v1` };
}

export interface FixtureBuild {
  code: number | null;
  output: string;
  /** Absolute path of the static output (empty when the build failed before writing it). */
  dir: string;
  /** Every file under `dir`, relative, posix separators. */
  files: string[];
  read(rel: string): string;
  cleanup(): void;
}

export interface FixtureOptions {
  items?: unknown[];
  env?: Record<string, string>;
  /** Contents for STRIPE_APPLE_PAY_DOMAIN_FILE; the file is written to a scratch directory. */
  stripeFile?: string;
}

const walk = (dir: string, base = ''): string[] =>
  readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, `${base}${e.name}/`) : [`${base}${e.name}`]));

export async function buildFixture(opts: FixtureOptions = {}): Promise<FixtureBuild> {
  const { server, url } = await serve(opts.items ?? fixtureItems());
  const scratch = mkdtempSync(path.join(tmpdir(), 'kesher-web-'));
  const distName = `.fixture-${path.basename(scratch)}`;
  const dir = path.join(appDir, distName);
  try {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(WEB_|LEGAL_|STRIPE_|NODE_ENV$)/.test(k)) env[k] = v;
    Object.assign(env, { NODE_ENV: 'production', WEB_ENV: 'local', LEGAL_API_URL: url, WEB_DIST_DIR: distName, NEXT_TELEMETRY_DISABLED: '1' });
    if (opts.stripeFile !== undefined) {
      mkdirSync(scratch, { recursive: true });
      const f = path.join(scratch, 'stripe-domain-file');
      writeFileSync(f, opts.stripeFile);
      env.STRIPE_APPLE_PAY_DOMAIN_FILE = f;
    }
    Object.assign(env, opts.env ?? {});
    const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
    const child = spawn(process.execPath, [nextBin, 'build'], { cwd: appDir, env: env as NodeJS.ProcessEnv });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const [code] = (await once(child, 'close')) as [number | null];
    let files: string[] = [];
    try {
      files = walk(dir);
    } catch {
      // the build failed before it wrote anything
    }
    return {
      code,
      output,
      dir,
      files,
      read: (rel) => readFileSync(path.join(dir, rel), 'utf8'),
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } finally {
    server.close();
  }
}

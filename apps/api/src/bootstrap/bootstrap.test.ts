import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_OWNER } from '../ledger/accounts.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { BOOTSTRAP_SYSTEM_ACCOUNTS, BootstrapError, maskEmail, run } from './bootstrap.ts';
import type { PgDatabase } from '../pg.ts';
import { describeFailure, isEntryPoint, main, parseArgs } from './index.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db.close());

const count = async (sql: string): Promise<number> => Number((await db.query<{ n: string }>(`select count(*)::text as n from (${sql}) t`)).rows[0]!.n);
const snapshot = async () => ({
  accounts: await count('select 1 from ledger.account'),
  approvals: await count('select 1 from ops.approval_request'),
  staff: await count('select 1 from org.staff'),
  legal: await count('select 1 from legal.document_version'),
  plans: await count('select 1 from billing.plan'),
  journals: await count('select 1 from ledger.journal'),
});

describe('production bootstrap (T-0046)', () => {
  it('creates the system accounts once; a second run creates nothing', async () => {
    const first = await run(db, { appEnv: 'prod', adminEmail: 'first.admin@example.org' });
    expect(first.created).toHaveLength(BOOTSTRAP_SYSTEM_ACCOUNTS.length * 2);
    expect(first.existing).toEqual([]);
    const after = await snapshot();
    const second = await run(db, { appEnv: 'prod', adminEmail: 'first.admin@example.org' });
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(first.created.length);
    expect(await snapshot()).toEqual(after);
  });

  it('creates fx_position and fee_income in USD and ILS, and every kind the code reads, owned by the system', async () => {
    const rows = await db.query<{ type: string; currency: string; normal_side: string; owner_party_id: string }>('select type, currency, normal_side, owner_party_id from ledger.account');
    const have = new Set(rows.rows.map((r) => `${r.type}:${r.currency}`));
    for (const type of ['fx_position', 'fee_income', 'partner_settlement', 'addon_payable']) for (const c of ['USD', 'ILS']) expect(have.has(`${type}:${c}`), `${type} ${c}`).toBe(true);
    expect(rows.rows.every((r) => r.owner_party_id === SYSTEM_OWNER)).toBe(true);
    expect(rows.rows.find((r) => r.type === 'addon_payable')!.normal_side).toBe('C');
    expect(rows.rows.find((r) => r.type === 'fee_income')!.normal_side).toBe('D');
  });

  it('covers every system account kind the source asks for', () => {
    const src = new URL('../', import.meta.url);
    const kinds = new Set<string>();
    for (const f of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.startsWith('bootstrap')) continue;
      for (const m of readFileSync(new URL(f, src), 'utf8').matchAll(/(?:findSystemAccount|systemAccount)\(\s*'([a-z_]+)'/g)) kinds.add(m[1]!);
    }
    expect([...kinds].sort()).toEqual([...BOOTSTRAP_SYSTEM_ACCOUNTS].sort());
  });

  it('creates no admin, no approval, no legal document and no plan: the first admin cannot be an invite', async () => {
    const s = await snapshot();
    expect(s).toMatchObject({ approvals: 0, staff: 0, legal: 0, plans: 0, journals: 0 });
    const report = await run(db, { appEnv: 'staging', adminEmail: 'first.admin@example.org' });
    expect(report.notes.join('\n')).toMatch(/first admin f\*\*\*@e\*\*\*\.org: NOT created/);
    expect(report.notes.join('\n')).not.toContain('first.admin');
  });

  it.each(['development', 'test', 'preview', 'production', '', undefined])('refuses APP_ENV=%s before touching the database', async (appEnv) => {
    const before = await snapshot();
    await expect(run(db, { appEnv })).rejects.toThrow(BootstrapError);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an address that is not one, and masks the ones it prints', async () => {
    await expect(run(db, { appEnv: 'prod', adminEmail: 'not-an-address' })).rejects.toThrow(/not an e-mail/);
    expect(maskEmail('zvi@kesher.co.il')).toBe('z***@k***.il');
  });

  it('inserts under club_app, the role the api task definition runs as', async () => {
    const fresh = await createTestDatabase();
    try {
      const asApp = await fresh.asRole('club_app', async (q) => run({ query: q.query, transaction: async (fn) => { await q.query('begin'); try { const out = await fn(q); await q.query('commit'); return out; } catch (e) { await q.query('rollback'); throw e; } } }, { appEnv: 'prod' }));
      expect(asApp.created).toHaveLength(8);
    } finally {
      await fresh.close();
    }
  });
});

describe('command line', () => {
  it('requires --admin-email and has no default', () => {
    expect(() => parseArgs([])).toThrow(/--admin-email/);
    expect(() => parseArgs(['--admin-email'])).toThrow(/--admin-email/);
    expect(parseArgs(['--admin-email', 'a@b.co'])).toEqual({ adminEmail: 'a@b.co' });
    expect(parseArgs(['--admin-email=a@b.co'])).toEqual({ adminEmail: 'a@b.co' });
  });

  it('accepts the literal -- that pnpm forwards', () => {
    expect(parseArgs(['--', '--admin-email', 'a@b.co'])).toEqual({ adminEmail: 'a@b.co' });
    expect(() => parseArgs(['--'])).toThrow(/--admin-email/);
  });

  it('never echoes an argument value: a stray address, an unknown flag value, a repeated flag', () => {
    const msg = (argv: string[]): string => {
      try {
        parseArgs(argv);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(msg(['stray.person@example.org'])).toBe('unknown argument 1');
    expect(msg(['--admin-email', 'a@b.co', 'other.person@example.org'])).toBe('unknown argument 3');
    expect(msg(['--x=secret.person@example.org'])).toBe('unknown argument 1 (--x)');
    const twice = msg(['--admin-email', 'first.person@example.org', '--admin-email=second.person@example.org']);
    expect(twice).toBe('--admin-email was given twice');
  });

  it('describes a driver failure by class and code only', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED postgres://u:hunter2@10.0.0.1/db'), { code: 'ECONNREFUSED' });
    expect(describeFailure(e)).toEqual({ error: 'Error', code: 'ECONNREFUSED' });
    expect(describeFailure(Object.assign(new Error('password hunter2'), { code: '28P01' }))).toEqual({ error: 'Error', code: '28P01' });
    expect(describeFailure(Object.assign(new Error('x'), { code: 'has spaces and hunter2' }))).toEqual({ error: 'Error' });
    expect(JSON.stringify(describeFailure(e))).not.toMatch(/hunter2|10\.0\.0\.1/);
    expect(describeFailure(new BootstrapError('refused: x'))).toEqual({ error: 'BootstrapError', message: 'refused: x' });
  });

  it('refuses before any connection opens: a refused environment, a bad argument and a missing URL never call connect', async () => {
    let opened = 0;
    const deps = { connect: () => { opened++; throw new Error('must not open'); }, out: () => undefined };
    await expect(main(['--admin-email', 'a@b.co'], { APP_ENV: 'development', DATABASE_URL: 'postgres://u:secret@h/db' }, deps)).rejects.toThrow(/APP_ENV/);
    await expect(main(['stray@example.org'], { APP_ENV: 'prod', DATABASE_URL: 'postgres://u:secret@h/db' }, deps)).rejects.toThrow(/unknown argument/);
    await expect(main(['--admin-email', 'a@b.co'], { APP_ENV: 'prod' }, deps)).rejects.toThrow(/DATABASE_URL/);
    expect(opened).toBe(0);
  });

  it('opens the database for a permitted run and closes it', async () => {
    const lines: string[] = [];
    let closed = false;
    const fake: PgDatabase = { query: db.query, transaction: db.transaction, close: async () => { closed = true; } };
    await main(['--', '--admin-email', 'a.person@example.org'], { APP_ENV: 'staging', DATABASE_URL: 'postgres://u:secret@h/db' }, { connect: () => fake, out: (l) => lines.push(l) });
    expect(closed).toBe(true);
    expect(lines.at(-1)).toBe(JSON.stringify({ service: 'bootstrap', event: 'done', created: 0, existing: 8 }));
    expect(lines.join('\n')).not.toMatch(/a\.person|secret/);
  });

  it('decides the entry point by real path, and runs when it cannot decide', () => {
    const here = fileURLToPath(new URL('./index.ts', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-link-'));
    try {
      const link = join(dir, 'link.ts');
      symlinkSync(here, link);
      expect(isEntryPoint(link, import.meta.url.replace('bootstrap.test.ts', 'index.ts'))).toBe(true);
      expect(isEntryPoint(undefined, import.meta.url)).toBe(false);
      expect(isEntryPoint(join(dir, 'missing.ts'), import.meta.url)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two racing runs report each account created exactly once', async () => {
    const fresh = await createTestDatabase();
    try {
      const [a, b] = await Promise.all([run(fresh, { appEnv: 'prod' }), run(fresh, { appEnv: 'prod' })]);
      expect(a.created.length + b.created.length).toBe(8);
      expect(new Set([...a.created, ...b.created]).size).toBe(8);
    } finally {
      await fresh.close();
    }
  });

  it('runs as a script under strip-types, exits 1 on a refused environment and prints no secret or address', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('./index.ts', import.meta.url)), '--admin-email', 'secret.person@example.org'], {
      encoding: 'utf8',
      env: { ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}), APP_ENV: 'development', DATABASE_URL: 'postgres://u:hunter2@localhost/db' },
    });
    expect(r.status).toBe(1);
    const line = JSON.parse(r.stderr.trim()) as { event: string; message: string };
    expect(line.event).toBe('failed');
    expect(r.stderr + r.stdout).not.toMatch(/hunter2|secret\.person/);
  });

  it('importing the module starts nothing', () => {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)}); console.log('ok')`], { encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });
});

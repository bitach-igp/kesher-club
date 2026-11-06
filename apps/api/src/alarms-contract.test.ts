// T-0054: the alert table in docs/runbooks/README.md and the alarms in infra/terraform/modules/alarms are one contract. Every row
// must have an alarm whose description names the alert and its RUN number, every worker job must have a stale-job alarm that treats
// missing data as breaching (a dead worker emits nothing), and the alarms must match the metrics the apps emit by dimension set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRIC_DEFS, METRICS_NAMESPACE } from '@kesher/domain';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODULE = 'infra/terraform/modules/alarms';
const moduleSource = (): string =>
  fs
    .readdirSync(path.join(ROOT, MODULE))
    .filter((f) => f.endsWith('.tf'))
    .map((f) => read(`${MODULE}/${f}`))
    .join('\n');

interface AlertRow {
  alert: string;
  runs: string[];
}

/** The rows of the "Alerts that page" table: alert name and every RUN number the row cites. */
function alertRows(): AlertRow[] {
  const readme = read('docs/runbooks/README.md');
  const section = readme.split(/^## Alerts that page\s*$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error('no "Alerts that page" section');
  const rows = section
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 4 && cells[1] !== 'Alert' && !/^-+$/.test(cells[1] ?? ''))
    .map((cells) => ({ alert: cells[1] ?? '', runs: [...(cells[3] ?? '').matchAll(/RUN-\d{2}/g)].map((m) => m[0]) }));
  return rows;
}

/** Every description the alarms and the backup rule set (one line each); a name such as "us-banking-recon" is not a description. */
function descriptions(): string[] {
  const out: string[] = [];
  const blocks = read(`${MODULE}/main.tf`).split(/^resource "/m).filter((b) => /^aws_cloudwatch_(metric_alarm|event_rule)"/.test(b));
  for (const block of blocks) {
    const line = /^\s*(?:alarm_description|description)\s*=\s*(.*)$/m.exec(block)?.[1] ?? '';
    out.push(...[...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '').filter((d) => d.includes(' ')));
  }
  return out;
}

/** An environment names the RUN of a per-service alarm (`Runbook ${each.value.run}`); that is checked where it is passed. */
const NAMES_RUN = /RUN-\d{2}|\$\{each\.value\.run\}/;

describe('runbook alert table and alarms (T-0054)', () => {
  it('reads every row of the table', () => {
    const rows = alertRows();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      expect(r.alert, 'row has an alert name').not.toBe('');
      expect(r.runs.length, `${r.alert} cites a RUN`).toBeGreaterThan(0);
    }
  });

  it('every row has an alarm whose description names the alert and each RUN of the row', () => {
    const found = descriptions();
    const missing = alertRows().filter((r) => !found.some((d) => d.includes(r.alert) && r.runs.every((run) => d.includes(run))));
    expect(missing.map((r) => `${r.alert} (${r.runs.join(', ')})`)).toEqual([]);
  });

  it('every description names a runbook, unless it is a ticket', () => {
    const bad = descriptions().filter((d) => !NAMES_RUN.test(d) && !d.includes('(ticket)'));
    expect(bad).toEqual([]);
  });

  it('every RUN named in a description has a runbook file', () => {
    const runs = new Set(descriptions().flatMap((d) => [...d.matchAll(/RUN-\d{2}/g)].map((m) => m[0])));
    const files = fs.readdirSync(path.join(ROOT, 'docs/runbooks'));
    for (const run of runs) expect(files.some((f) => f.startsWith(`${run}-`)), run).toBe(true);
  });

  it('has a stale-job alarm per worker job, with missing data breaching', () => {
    const jobs = [...read('apps/worker/src/jobs.ts').matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1] ?? '');
    expect(jobs.length).toBeGreaterThan(20);
    const table = /jobs\s*=\s*\{([\s\S]*?)\n\s{2}\}/.exec(read(`${MODULE}/main.tf`))?.[1] ?? '';
    const alarmed = [...table.matchAll(/^\s*"([a-z0-9-]+)"\s*=/gm)].map((m) => m[1] ?? '');
    expect([...alarmed].sort()).toEqual([...jobs].sort());
    const stale = /resource "aws_cloudwatch_metric_alarm" "job_stale" \{[\s\S]*?\n\}/.exec(moduleSource())?.[0] ?? '';
    expect(stale).toContain('metric_name         = "job.age_s"');
    expect(stale).toContain('treat_missing_data  = "breaching"');
  });

  it('alarms on application metrics use the namespace and exact dimension sets the app emits', () => {
    const src = moduleSource();
    expect(src).toContain(`namespace   = "${METRICS_NAMESPACE}"`);
    // alarm resource -> [metric, dimension names it sets]
    const expected: Record<string, [keyof typeof METRIC_DEFS, string[]]> = {
      jit_latency: ['jit.decision_ms', []],
      jit_errors: ['jit.error', []],
      webhook_lag: ['webhook.lag_s', ['market']],
      recon_break_amount: ['recon.break_open_usd', []],
      recon_break_age: ['recon.break_oldest_h', []],
      workflow_failure: ['job.failure', ['job']],
      job_failure_ticket: ['job.failure', ['job']],
      transfer_stuck: ['transfer.stuck', ['state', 'market']],
      job_stale: ['job.age_s', ['job']],
      port_errors: ['provider.error', ['port']],
      us_banking_errors: ['provider.error', ['port']],
    };
    for (const [resource, [metric, dims]] of Object.entries(expected)) {
      const body = new RegExp(`resource "aws_cloudwatch_metric_alarm" "${resource}" \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
      expect(body, resource).toBeDefined();
      expect(body, resource).toContain(`metric_name         = "${metric}"`);
      const set = /dimensions = \{([\s\S]*?)\}/.exec(body ?? '')?.[1] ?? '';
      expect([...set.matchAll(/^\s*([A-Za-z]+)\s*=/gm)].map((m) => m[1]).sort(), resource).toEqual([...dims].sort());
      expect([...METRIC_DEFS[metric].dimensions].sort(), `${resource} matches METRIC_DEFS`).toEqual([...dims].sort());
    }
  });
});

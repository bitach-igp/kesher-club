// Tests for .github/workflows/deploy.yml (T-0050). Run with `node --test tools/release/*.test.mjs` (the root `pnpm test` does).
// The repo has no YAML dependency, so the workflow is read with a small indentation parser that understands exactly the layout the
// file uses (jobs at 2 spaces, steps as `      - ` list items, `run: |` blocks). The prod gate and the input check are also run
// for real, with bash and a stub `aws` on the PATH, when bash and jq exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
const lines = text.split('\n');

const indentOf = (l) => l.length - l.trimStart().length;

/** The lines of a top-level or job-level block: everything after `header` that is indented deeper than it. */
function block(from, header, headerIndent) {
  const start = from.findIndex((l, i) => l === `${' '.repeat(headerIndent)}${header}` && i >= 0);
  assert.notEqual(start, -1, `missing ${header}`);
  const out = [];
  for (let i = start + 1; i < from.length; i += 1) {
    const l = from[i];
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && indentOf(l) <= headerIndent) break;
    out.push(l);
  }
  return out;
}

function parseJobs() {
  const body = block(lines, 'jobs:', 0);
  const jobs = {};
  let current;
  for (const l of body) {
    const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(l);
    if (m) {
      current = { id: m[1], lines: [] };
      jobs[m[1]] = current;
    } else if (current) current.lines.push(l);
  }
  for (const job of Object.values(jobs)) {
    const stepLines = block(job.lines, 'steps:', 4);
    job.steps = [];
    for (const l of stepLines) {
      if (/^ {6}- /.test(l)) job.steps.push({ lines: [l.replace(/^ {6}- /, '        ')] });
      else if (job.steps.length > 0) job.steps[job.steps.length - 1].lines.push(l);
    }
    for (const step of job.steps) {
      const props = {};
      for (let i = 0; i < step.lines.length; i += 1) {
        const m = /^ {8}([a-z-]+):\s?(.*)$/.exec(step.lines[i]);
        if (!m) continue;
        const [, key, rest] = m;
        if (rest === '|' || rest === '>') {
          const buf = [];
          for (let j = i + 1; j < step.lines.length; j += 1) {
            const l = step.lines[j];
            if (l.trim() !== '' && indentOf(l) <= 8) break;
            buf.push(l.slice(10));
          }
          props[key] = buf.join('\n').trimEnd();
        } else props[key] = rest.trim();
      }
      step.props = props;
      step.name = props['name'] ?? props['uses'] ?? '(unnamed)';
      step.text = step.lines.join('\n');
    }
  }
  return jobs;
}

const jobs = parseJobs();
const deploy = jobs['deploy'];
const verify = jobs['verify'];
const stepIndex = (job, re) => {
  const i = job.steps.findIndex((s) => re.test(s.name));
  assert.notEqual(i, -1, `no step matching ${re}`);
  return i;
};
const runSteps = (job) => job.steps.filter((s) => s.props['run'] !== undefined);
const commandCount = (run) => run.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length;

test('the workflow has the two jobs and runs deploy behind verify', () => {
  assert.deepEqual(Object.keys(jobs), ['verify', 'deploy']);
  assert.match(deploy.lines.join('\n'), /^ {4}needs: verify$/m);
});

test('workflow_dispatch takes a staging|prod choice and a string image_tag', () => {
  const on = block(lines, 'on:', 0).join('\n');
  assert.match(on, /^ {2}workflow_dispatch:$/m);
  const env = /^ {6}environment:\n((?: {8}.*\n)+)/m.exec(on);
  assert.ok(env, 'environment input');
  assert.match(env[1], /type: choice/);
  assert.match(env[1], /required: true/);
  assert.match(env[1], /- staging\n\s+- prod/);
  const tag = /^ {6}image_tag:\n((?: {8}.*\n)+)/m.exec(on);
  assert.ok(tag, 'image_tag input');
  assert.match(tag[1], /type: string/);
  assert.match(tag[1], /required: true/);
});

test('image_tag is validated against ^sha-[0-9a-f]{12}$ in both jobs, before any AWS call', () => {
  for (const job of [verify, deploy]) {
    const i = job.steps.findIndex((s) => (s.props['run'] ?? '').includes('^sha-[0-9a-f]{12}$'));
    assert.notEqual(i, -1, `${job.id} validates the tag`);
    const aws = job.steps.findIndex((s) => (s.props['uses'] ?? '').startsWith('aws-actions/configure-aws-credentials'));
    assert.ok(i < aws, `${job.id} validates before it assumes a role`);
  }
  const re = /^sha-[0-9a-f]{12}$/;
  for (const ok of ['sha-0123456789ab', 'sha-ffffffffffff']) assert.ok(re.test(ok));
  for (const bad of ['sha-0123456789a', 'sha-0123456789abc', 'sha-0123456789AB', 'latest', 'sha-0123456789ab\nx', ' sha-0123456789ab', 'sha-0123456789ag']) assert.ok(!re.test(bad), bad);
});

test('one concurrency group per environment, never cancelling a running deploy', () => {
  const c = block(lines, 'concurrency:', 0).join('\n');
  assert.match(c, /group: deploy-\$\{\{ inputs\.environment \}\}/);
  assert.match(c, /cancel-in-progress: false/);
});

test('permissions are least privilege: contents read and id-token write only', () => {
  const p = block(lines, 'permissions:', 0).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(p.sort(), ['contents: read', 'id-token: write']);
  assert.ok(!/^ {4}permissions:/m.test(text), 'no job widens the permissions');
});

test('the deploy job runs on the GitHub environment named by the input', () => {
  assert.match(deploy.lines.join('\n'), /^ {4}environment: \$\{\{ inputs\.environment \}\}$/m);
});

test('credentials come from OIDC: the CI role, then a deploy-role profile; no static keys', () => {
  assert.doesNotMatch(text, /aws-access-key-id|aws-secret-access-key|secrets\.AWS_/i);
  assert.match(deploy.text ?? deploy.lines.join('\n'), /role-to-assume: \$\{\{ vars\.AWS_CI_ROLE_ARN \}\}/);
  const profiles = deploy.steps[stepIndex(deploy, /deploy-role profiles/)].props['run'];
  assert.match(profiles, /role\/kesher-deploy/);
  assert.match(profiles, /credential_source = Environment/);
  // every aws call in the deploy job names a profile
  for (const s of runSteps(deploy)) {
    for (const l of s.props['run'].split('\n')) {
      if (/\baws (ssm|ecs|logs|sts)\b/.test(l) && !l.trim().startsWith('#')) assert.match(l, /--profile (deploy|staging)/, `${s.name}: ${l.trim()}`);
    }
  }
});

test('terraform plans are written to the job summary and the saved plan is what is applied', () => {
  const plan = deploy.steps[stepIndex(deploy, /Plan the whole root/)].props['run'];
  assert.match(plan, /-out=deploy\.tfplan/);
  assert.match(plan, /GITHUB_STEP_SUMMARY/);
  assert.match(plan, /-var "image_tag=\$\{TAG\}"/);
  const apply = deploy.steps[stepIndex(deploy, /Apply the saved plan/)].props['run'];
  assert.match(apply, /terraform apply .*deploy\.tfplan$/);
  assert.doesNotMatch(apply, /auto-approve/);
});

test('the migrate task runs and must exit 0 BEFORE anything that can roll a service', () => {
  const idx = {
    planMigrate: stepIndex(deploy, /Plan the migrate task definition only/),
    applyMigrate: stepIndex(deploy, /Apply the migrate task definition/),
    runMigrate: stepIndex(deploy, /Run the migrate task and wait for exit 0/),
    planAll: stepIndex(deploy, /Plan the whole root/),
    applyAll: stepIndex(deploy, /Apply the saved plan/),
    wait: stepIndex(deploy, /Wait for every ECS service/),
    smoke: stepIndex(deploy, /Smoke suite/),
    record: stepIndex(deploy, /Record the deployed tag in SSM/),
  };
  const order = Object.values(idx);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'steps appear in the designed order');
  // before the migrate task has run, terraform may only plan or apply the targeted, migrate-only plan
  for (const s of deploy.steps.slice(0, idx.runMigrate + 1)) {
    const run = s.props['run'] ?? '';
    if (/terraform (plan|apply)/.test(run)) {
      const ok = /-target=module\.migrate\b/.test(run) || /terraform apply [^\n]*migrate\.tfplan/.test(run);
      assert.ok(ok, `${s.name} touches terraform before the migrate task ran, and not as the migrate-only plan`);
    }
  }
  const plan = deploy.steps[idx.planMigrate].props['run'];
  assert.match(plan, /-out=migrate\.tfplan/);
  assert.match(plan, /startswith\("module\.migrate\."\)/, 'the targeted plan is checked to change nothing outside module.migrate');
  const run = deploy.steps[idx.runMigrate].props['run'];
  assert.match(run, /aws ecs run-task/);
  assert.match(run, /kesher\/migrate:"\$\{TAG\}"/, 'runs the image of the new tag');
  assert.match(run, /!= "0"/, 'fails on any exit code but 0');
  assert.match(run, /exit 1/);
  // the service waits and the smoke suite come after the full apply
  assert.ok(idx.wait > idx.applyAll && idx.smoke > idx.wait);
});

test('a rolled-back service does not pass the stability wait', () => {
  const wait = deploy.steps[stepIndex(deploy, /Wait for every ECS service/)].props['run'];
  assert.match(wait, /aws ecs wait services-stable/);
  assert.match(wait, /ecs_service_names/);
  assert.match(wait, /COMPLETED/);
  assert.match(wait, /containerDefinitions\[\]\.image/);
});

test('the smoke suite runs the documented non-strict command and prints the previous tag on failure', () => {
  const s = deploy.steps[stepIndex(deploy, /Smoke suite/)];
  const run = s.props['run'];
  assert.match(run, /tools\/smoke\/index\.mjs/);
  assert.doesNotMatch(run, /--strict/);
  for (const flag of ['--base-url', '--jit-url', '--admin-url', '--web-url', '--expected-tag']) assert.ok(run.includes(flag), flag);
  assert.doesNotMatch(run, /--console-url|--openapi-url/);
  assert.match(run, /PREVIOUS/);
  assert.match(s.text, /PREVIOUS: \$\{\{ steps\.previous\.outputs\.value \}\}/);
  assert.ok(stepIndex(deploy, /previously deployed tag/) < stepIndex(deploy, /Apply the migrate task definition/), 'the previous tag is read before anything is applied');
});

test('the deployed tag and time are recorded in SSM, only after the smoke suite', () => {
  const rec = deploy.steps[stepIndex(deploy, /Record the deployed tag in SSM/)];
  assert.match(rec.props['run'], /aws ssm put-parameter .*\/kesher\/\$\{ENVIRONMENT\}\/deployed-image-tag.* --overwrite/);
  assert.match(rec.props['run'], /\/kesher\/\$\{ENVIRONMENT\}\/deployed-at/);
  assert.ok(!rec.props['if'], 'no if: it runs only when every earlier step passed');
  assert.equal(deploy.steps.indexOf(rec), stepIndex(deploy, /Smoke suite/) + 1);
});

test('the prod gate is the first step of the prod path, before any change', () => {
  const i = stepIndex(deploy, /Prod gate/);
  const gate = deploy.steps[i];
  assert.equal(gate.props['if'], "${{ inputs.environment == 'prod' }}");
  assert.match(gate.props['run'], /\/kesher\/staging\/deployed-image-tag/);
  assert.match(gate.props['run'], /--profile staging/);
  assert.match(gate.props['run'], /min_age=3600/);
  assert.ok(i < stepIndex(deploy, /Terraform init/));
  assert.ok(i < stepIndex(deploy, /previously deployed tag/));
  const firstTerraform = deploy.steps.findIndex((s) => /terraform /.test(s.props['run'] ?? ''));
  assert.ok(i < firstTerraform);
});

test('every multi-command run step sets pipefail', () => {
  for (const job of [verify, deploy]) {
    for (const s of runSteps(job)) {
      if (commandCount(s.props['run']) > 1) assert.match(s.props['run'], /^set -euo pipefail$/m, `${job.id}: ${s.name}`);
    }
  }
  // the failure a pipe into tee used to swallow (release.yml): every `| tee` sits under pipefail
  for (const job of [verify, deploy]) for (const s of runSteps(job)) if (/\|\s*tee\b/.test(s.props['run'])) assert.match(s.props['run'], /set -euo pipefail/, s.name);
});

test('no expression is interpolated into a run script: inputs reach scripts only through env', () => {
  for (const job of [verify, deploy]) {
    for (const s of runSteps(job)) {
      assert.doesNotMatch(s.props['run'], /\$\{\{/, `${job.id}: ${s.name} interpolates an expression into its script`);
    }
  }
  assert.doesNotMatch(runSteps(deploy).map((s) => s.props['run']).join('\n'), /inputs\./);
  // and the values the scripts read are set in env
  assert.match(deploy.lines.join('\n'), /^ {6}TAG: \$\{\{ inputs\.image_tag \}\}$/m);
  assert.match(deploy.lines.join('\n'), /^ {6}ENVIRONMENT: \$\{\{ inputs\.environment \}\}$/m);
});

test('actions are pinned to the major versions release.yml and preview.yml use', () => {
  const uses = [...text.matchAll(/uses: ([\w./-]+)@(\S+)/g)].map((m) => `${m[1]}@${m[2]}`).sort();
  assert.deepEqual([...new Set(uses)], ['actions/checkout@v4', 'actions/setup-node@v4', 'aws-actions/configure-aws-credentials@v4', 'hashicorp/setup-terraform@v3']);
});

test('both Terraform roots export the service names the workflow waits on', () => {
  for (const env of ['staging', 'prod']) {
    const tf = fs.readFileSync(path.join(root, 'infra/terraform/envs', env, 'main.tf'), 'utf8');
    assert.match(tf, /output "ecs_service_names"/, env);
  }
});

test('the docs describe the real flow', () => {
  const release = fs.readFileSync(path.join(root, 'docs/setup/release.md'), 'utf8');
  assert.doesNotMatch(release, /a card of its own/);
  assert.match(release, /deploy\.yml/);
  const deployDoc = fs.readFileSync(path.join(root, 'docs/setup/deploy.md'), 'utf8');
  for (const needle of ['deploy.yml', 'required reviewers', 'AWS_PROD_ACCOUNT_ID', 'TERRAFORM_VARS', 'PAGER_ENDPOINT', '/kesher/<env>/deployed-image-tag', 'roll back']) assert.ok(deployDoc.includes(needle), needle);
});

// ---- the shell steps, run for real ---------------------------------------------------------------------------------------

const haveTools = ['bash', 'jq'].every((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0) && process.platform !== 'win32';
const maybe = haveTools ? test : test.skip;

function runStep(step, env, fakeAws) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-wf-'));
  try {
    if (fakeAws) {
      fs.writeFileSync(path.join(dir, 'aws'), fakeAws, { mode: 0o755 });
    }
    return spawnSync('bash', ['-e', '-c', step.props['run']], {
      env: { PATH: `${dir}${path.delimiter}${process.env['PATH']}`, HOME: dir, ...env },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

maybe('the input check refuses a bad tag, a ref that is not main and an unknown environment', () => {
  const step = verify.steps[stepIndex(verify, /Check the inputs/)];
  const base = { GITHUB_REF: 'refs/heads/main', TAG: 'sha-0123456789ab', ENVIRONMENT: 'staging', CI_ROLE: 'arn:aws:iam::111111111111:role/x', REGISTRY_ID: '111111111111' };
  assert.equal(runStep(step, base).status, 0);
  assert.equal(runStep(step, { ...base, TAG: 'sha-0123456789a' }).status, 1);
  assert.equal(runStep(step, { ...base, TAG: 'sha-0123456789ab; echo hi' }).status, 1);
  assert.equal(runStep(step, { ...base, TAG: '$(touch pwned)' }).status, 1);
  assert.equal(runStep(step, { ...base, GITHUB_REF: 'refs/heads/feature' }).status, 1);
  assert.equal(runStep(step, { ...base, ENVIRONMENT: 'dev' }).status, 1);
  assert.equal(runStep(step, { ...base, REGISTRY_ID: '' }).status, 1);
});

// A stub `aws`: `ssm get-parameter` answers staging's record, `ssm get-parameter-history` prod's history. Both read canned files.
const FAKE_AWS = `#!/usr/bin/env bash
set -u
case "$*" in
  *"ssm get-parameter-history"*) out="$PROD_HISTORY" ;;
  *"ssm get-parameter "*) out="$STAGING_PARAM" ;;
  *) echo "unexpected aws call: $*" >&2; exit 2 ;;
esac
if [ "$out" = "NOTFOUND" ]; then
  echo "An error occurred (ParameterNotFound) when calling the operation: x" >&2
  exit 254
fi
printf '%s\\n' "$out"
`;

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+00:00');
const param = (value, msAgo) => JSON.stringify({ Parameter: { Value: value, LastModifiedDate: iso(msAgo) } });
const history = (...values) => JSON.stringify({ Parameters: values.map((Value) => ({ Value })) });
const TAG = 'sha-0123456789ab';
const OTHER = 'sha-fedcba987654';
const HOUR = 3600 * 1000;

maybe('prod gate: only a tag staging has run for an hour passes, or a tag prod already ran (rollback)', () => {
  const gate = deploy.steps[stepIndex(deploy, /Prod gate/)];
  const run = (stagingParam, prodHistory) => runStep(gate, { TAG, STAGING_PARAM: stagingParam, PROD_HISTORY: prodHistory }, FAKE_AWS);

  assert.equal(run(param(TAG, 2 * HOUR), 'NOTFOUND').status, 0, 'two hours on staging passes');
  assert.equal(run(param(TAG, HOUR + 1000), 'NOTFOUND').status, 0, 'just over an hour passes');

  const young = run(param(TAG, 30 * 60 * 1000), 'NOTFOUND');
  assert.equal(young.status, 1, 'half an hour fails');
  assert.match(young.stdout, /needs 3600/);

  const other = run(param(OTHER, 5 * HOUR), 'NOTFOUND');
  assert.equal(other.status, 1, 'staging on another tag fails');
  assert.match(other.stdout, new RegExp(`Staging runs ${OTHER}, not ${TAG}`));

  const none = run('NOTFOUND', 'NOTFOUND');
  assert.equal(none.status, 1, 'no staging record fails');
  assert.match(none.stdout, /no deployed-image-tag record/);

  assert.equal(run(param(OTHER, 5 * HOUR), history(OTHER, TAG)).status, 0, 'a tag prod already ran may roll back');
  assert.equal(run(param(OTHER, 5 * HOUR), history('sha-aaaaaaaaaaaa')).status, 1, 'a tag prod never ran does not');
});

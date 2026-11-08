// Tests for .github/workflows/deploy.yml and tools/release/deploy/*.sh (T-0050). Run with `node --test tools/release/*.test.mjs` (the root `pnpm test` does).
// The repo has no YAML dependency, so the workflow is read with a small indentation parser that understands exactly the layout the file uses.
// The decisions live in small scripts that the workflow calls; those are run for real, with bash and jq and a stub `aws` first on the PATH
// (skipped where bash or jq is missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
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

const scriptDir = path.join(root, 'tools/release/deploy');
const scripts = fs.readdirSync(scriptDir).filter((f) => f.endsWith('.sh'));

// ---- structure of the workflow -------------------------------------------------------------------------------------------

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

test('credentials come from OIDC; every aws call names a deploy-role profile', () => {
  assert.doesNotMatch(text, /aws-access-key-id|aws-secret-access-key|secrets\.AWS_/i);
  assert.match(deploy.lines.join('\n'), /role-to-assume: \$\{\{ vars\.AWS_CI_ROLE_ARN \}\}/);
  const sources = [
    ...[verify, deploy].flatMap((j) => runSteps(j).map((s) => [s.name, s.props['run']])),
    ...scripts.map((f) => [f, fs.readFileSync(path.join(scriptDir, f), 'utf8')]),
  ];
  for (const [name, src] of sources) {
    for (const l of src.split('\n')) {
      const t = l.trim();
      if (t.startsWith('#') || t.startsWith('echo') || !/\baws (ssm|ecs|logs|sts)\b/.test(t)) continue;
      assert.match(t, /--profile (deploy|staging|"\$profile")/, `${name}: ${t}`);
    }
  }
  const profiles = fs.readFileSync(path.join(scriptDir, 'configure-profiles.sh'), 'utf8');
  assert.match(profiles, /role\/kesher-deploy/);
  assert.match(profiles, /credential_source = Environment/);
});

test('both environments need the pager secret (https://), checked before anything changes', () => {
  const check = deploy.steps[stepIndex(deploy, /Check the inputs, the variables and the secrets/)];
  assert.match(check.props['run'], /\[\[ "\$PAGER" != https:\/\/\* \]\]/);
  assert.doesNotMatch(check.props['run'], /ENVIRONMENT" = "prod" \] && \[ -z "\$PAGER"/);
  assert.ok(stepIndex(deploy, /Check the inputs, the variables and the secrets/) < stepIndex(deploy, /Plan the migrate task definition only/));
  assert.match(deploy.lines.join('\n'), /TF_VAR_pager_endpoint: \$\{\{ secrets\.PAGER_ENDPOINT \}\}/);
});

test('terraform plans go to the job summary and the saved plan is what is applied', () => {
  const plan = deploy.steps[stepIndex(deploy, /Plan the whole root/)].props['run'];
  assert.match(plan, /-out=deploy\.tfplan/);
  assert.match(plan, /GITHUB_STEP_SUMMARY/);
  assert.match(plan, /-var "image_tag=\$\{TAG\}"/);
  const apply = deploy.steps[stepIndex(deploy, /Apply the saved plan/)];
  assert.match(apply.props['run'], /terraform apply .*deploy\.tfplan$/);
  assert.doesNotMatch(apply.props['run'], /auto-approve/);
  assert.equal(apply.props['id'], 'apply_all');
});

test('the migrate task runs and must exit 0 BEFORE anything that can roll a service', () => {
  const idx = {
    previous: stepIndex(deploy, /previously deployed tag/),
    mark: stepIndex(deploy, /Mark the deploy in progress/),
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
  for (const s of deploy.steps.slice(0, idx.runMigrate + 1)) {
    const run = s.props['run'] ?? '';
    if (/terraform (plan|apply)/.test(run)) {
      const ok = /-target=module\.migrate\b/.test(run) || /terraform apply [^\n]*migrate\.tfplan/.test(run);
      assert.ok(ok, `${s.name} touches terraform before the migrate task ran, and not as the migrate-only plan`);
    }
  }
  const plan = deploy.steps[idx.planMigrate].props['run'];
  assert.match(plan, /-out=migrate\.tfplan/);
  assert.match(plan, /check-plan\.sh" migrate-plan\.json module\.migrate\./);
  assert.match(deploy.steps[idx.runMigrate].props['run'], /run-migrate\.sh/);
  assert.match(deploy.steps[idx.wait].props['run'], /check-services\.sh/);
});

test('the account check, the previous-tag read and the in-progress mark come before the first change', () => {
  const account = stepIndex(deploy, /same account/);
  assert.ok(account < stepIndex(deploy, /previously deployed tag/));
  assert.ok(stepIndex(deploy, /Write the Terraform variables/) < account);
  const mark = deploy.steps[stepIndex(deploy, /Mark the deploy in progress/)].props['run'];
  assert.match(mark, /aws ssm put-parameter .*\/kesher\/\$\{ENVIRONMENT\}\/deploy-in-progress.* --overwrite/);
  assert.ok(stepIndex(deploy, /Mark the deploy in progress/) < stepIndex(deploy, /Terraform init/));
});

test('the smoke suite runs the documented non-strict command; a failure names the previous tag, or says there is none', () => {
  const s = deploy.steps[stepIndex(deploy, /Smoke suite/)];
  const run = s.props['run'];
  assert.match(run, /tools\/smoke\/index\.mjs/);
  assert.doesNotMatch(run, /--strict/);
  for (const flag of ['--base-url', '--jit-url', '--admin-url', '--web-url', '--expected-tag']) assert.ok(run.includes(flag), flag);
  assert.doesNotMatch(run, /--console-url|--openapi-url/);
  assert.match(s.text, /PREVIOUS: \$\{\{ steps\.previous\.outputs\.value \}\}/);
  assert.match(run, /sha-\*\) hint=.*image_tag=\$\{PREVIOUS\}/);
  assert.match(run, /nothing to roll back to/);
  assert.doesNotMatch(run, /image_tag=none/);
});

test('the tag and time are recorded last, then the in-progress mark is cleared', () => {
  const rec = deploy.steps[stepIndex(deploy, /Record the deployed tag in SSM/)];
  const run = rec.props['run'];
  assert.match(run, /aws ssm put-parameter .*\/kesher\/\$\{ENVIRONMENT\}\/deployed-image-tag.* --overwrite/);
  assert.match(run, /\/kesher\/\$\{ENVIRONMENT\}\/deployed-at/);
  assert.ok(run.indexOf('deployed-image-tag') < run.indexOf('delete-parameter') && run.includes('deploy-in-progress'));
  assert.ok(!rec.props['if'], 'no if: it runs only when every earlier step passed');
  assert.equal(deploy.steps.indexOf(rec), stepIndex(deploy, /Smoke suite/) + 1);
});

test('the prod gate runs in verify, before the reviewers are asked, and again after they approve', () => {
  const gate = verify.steps[stepIndex(verify, /Prod gate/)];
  assert.equal(gate.props['if'], "${{ inputs.environment == 'prod' }}");
  assert.match(gate.props['run'], /prod-gate\.sh/);
  assert.ok(stepIndex(verify, /deploy-role profiles/) < stepIndex(verify, /Prod gate/));
  const again = stepIndex(deploy, /Prod gate again/);
  assert.equal(deploy.steps[again].props['if'], "${{ inputs.environment == 'prod' }}");
  assert.match(deploy.steps[again].props['run'], /prod-gate\.sh/);
  assert.ok(again < stepIndex(deploy, /Mark the deploy in progress/));
  assert.ok(again < stepIndex(deploy, /Terraform init/));
});

test('a failed deploy says how to roll back only when the services were applied', () => {
  const roll = deploy.steps[stepIndex(deploy, /Say how to roll back/)];
  assert.match(roll.props['if'], /failure\(\) && steps\.apply_all\.outcome != 'skipped'/);
  assert.match(roll.props['run'], /nothing to roll back to/);
  assert.doesNotMatch(roll.props['run'], /image_tag `none`/);
  const none = deploy.steps[stepIndex(deploy, /Say nothing rolled/)];
  assert.match(none.props['if'], /failure\(\) && steps\.apply_all\.outcome == 'skipped'/);
});

test('every multi-command run step and every script sets pipefail', () => {
  for (const job of [verify, deploy]) {
    for (const s of runSteps(job)) {
      if (commandCount(s.props['run']) > 1) assert.match(s.props['run'], /^set -euo pipefail$/m, `${job.id}: ${s.name}`);
      if (/\|\s*tee\b/.test(s.props['run'])) assert.match(s.props['run'], /set -euo pipefail/, s.name);
    }
  }
  for (const f of scripts) {
    if (f === 'lib.sh') continue;
    assert.match(fs.readFileSync(path.join(scriptDir, f), 'utf8'), /^set -euo pipefail$/m, f);
  }
});

test('no expression is interpolated into a run script: inputs reach scripts only through env', () => {
  for (const job of [verify, deploy]) {
    for (const s of runSteps(job)) {
      assert.doesNotMatch(s.props['run'], /\$\{\{/, `${job.id}: ${s.name} interpolates an expression into its script`);
    }
  }
  assert.doesNotMatch(runSteps(deploy).map((s) => s.props['run']).join('\n'), /inputs\./);
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
    assert.doesNotMatch(tf, /no workflow does/, env);
  }
});

test('the docs describe the real flow and the IAM limit', () => {
  const release = fs.readFileSync(path.join(root, 'docs/setup/release.md'), 'utf8');
  assert.doesNotMatch(release, /a card of its own/);
  assert.match(release, /deploy\.yml/);
  const deployDoc = fs.readFileSync(path.join(root, 'docs/setup/deploy.md'), 'utf8');
  for (const needle of ['deploy.yml', 'required reviewers', 'AWS_PROD_ACCOUNT_ID', 'TERRAFORM_VARS', 'PAGER_ENDPOINT', '/kesher/<env>/deployed-image-tag', 'deploy-in-progress', 'roll back', 'T-0070']) assert.ok(deployDoc.includes(needle), needle);
  assert.doesNotMatch(deployDoc, /No IAM change was needed/);
});

// ---- the scripts, run for real with a stub `aws` --------------------------------------------------------------------------

const haveTools = ['bash', 'jq'].every((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0) && process.platform !== 'win32';
const maybe = haveTools ? test : test.skip;

/** A scratch directory with a stub `aws` first on the PATH. `body` is bash; $STUB is the directory, every call is appended to $STUB/calls. */
function sandbox(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-wf-'));
  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env bash\nSTUB="${dir}"\necho "$*" >> "$STUB/calls"\n${body}\n`, { mode: 0o755 });
  return {
    dir,
    write: (name, content) => fs.writeFileSync(path.join(dir, name), content),
    calls: () => (fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : ''),
    env: (extra = {}) => ({ PATH: `${dir}${path.delimiter}${process.env['PATH']}`, HOME: dir, ...extra }),
    run(script, args, extra = {}) {
      return spawnSync('bash', [path.join(scriptDir, script), ...args], { env: this.env(extra), encoding: 'utf8', timeout: 30000 });
    },
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
const withSandbox = (body, fn) => {
  const sb = sandbox(body);
  try {
    return fn(sb);
  } finally {
    sb.done();
  }
};
const TAG = 'sha-0123456789ab';
const OTHER = 'sha-fedcba987654';

maybe('the input check refuses a bad tag, a ref that is not main and an unknown environment', () => {
  const step = verify.steps[stepIndex(verify, /Check the inputs/)];
  const base = { GITHUB_REF: 'refs/heads/main', TAG, ENVIRONMENT: 'staging', CI_ROLE: 'arn:aws:iam::111111111111:role/x', REGISTRY_ID: '111111111111', STAGING_ACCOUNT: '222222222222', PROD_ACCOUNT: '' };
  const run = (extra) => spawnSync('bash', ['-e', '-c', step.props['run']], { env: { PATH: process.env['PATH'], ...base, ...extra }, encoding: 'utf8' }).status;
  assert.equal(run({}), 0);
  assert.equal(run({ TAG: 'sha-0123456789a' }), 1);
  assert.equal(run({ TAG: 'sha-0123456789ab; echo hi' }), 1);
  assert.equal(run({ TAG: '$(touch pwned)' }), 1);
  assert.equal(run({ TAG: 'sha-0123456789AB' }), 1);
  assert.equal(run({ GITHUB_REF: 'refs/heads/feature' }), 1);
  assert.equal(run({ ENVIRONMENT: 'dev' }), 1);
  assert.equal(run({ REGISTRY_ID: '' }), 1);
  assert.equal(run({ ENVIRONMENT: 'prod' }), 1, 'prod without AWS_PROD_ACCOUNT_ID');
  assert.equal(run({ ENVIRONMENT: 'prod', PROD_ACCOUNT: '333333333333' }), 0);
});

// -- check-plan.sh: the migrate-only plan must not change anything else --
const planOf = (...changes) => JSON.stringify({ resource_changes: changes.map(([address, actions]) => ({ address, change: { actions } })) });

maybe('check-plan: a change outside module.migrate fails; no-op and read do not', () => {
  withSandbox('', (sb) => {
    const check = (plan) => {
      sb.write('plan.json', plan);
      return sb.run('check-plan.sh', [path.join(sb.dir, 'plan.json'), 'module.migrate.']);
    };
    assert.equal(check(planOf(['module.migrate.aws_ecs_task_definition.this', ['update']], ['module.migrate.aws_ecs_task_definition.this', ['create']])).status, 0);
    assert.equal(check(planOf(['module.migrate.aws_ecs_task_definition.this', ['delete', 'create']])).status, 0);
    assert.equal(check(planOf(['module.api["il"].aws_ecs_service.this', ['no-op']], ['data.aws_partition.current', ['read']], ['module.migrate.x', ['update']])).status, 0);
    assert.equal(check(JSON.stringify({})).status, 0, 'a plan with no changes');
    const upd = check(planOf(['module.migrate.x', ['update']], ['module.api["il"].aws_ecs_service.this', ['update']]));
    assert.equal(upd.status, 1);
    assert.match(upd.stdout, /module\.api\["il"\]\.aws_ecs_service\.this/);
    assert.equal(check(planOf(['module.rds.aws_db_instance.this', ['delete', 'create']])).status, 1);
    assert.equal(check(planOf(['module.migrator.x', ['create']])).status, 1, 'a module that only shares the prefix text');
    assert.equal(check(planOf(['aws_ecs_cluster.this', ['delete']])).status, 1);
  });
});

// -- prod-gate.sh --
// The stub answers `aws ssm get-parameter[-history] --name N` from files named "<sub>__<name with / as _>"; a file holding NOTFOUND or DENIED
// answers with that error, a missing file is ParameterNotFound.
const SSM_STUB = `
sub="$2"; name=""
while [ $# -gt 0 ]; do if [ "$1" = "--name" ]; then name="$2"; fi; shift; done
f="$STUB/$sub$(printf '%s' "$name" | tr '/' '_')"
if [ ! -f "$f" ]; then echo "An error occurred (ParameterNotFound) when calling the operation" >&2; exit 254; fi
c="$(cat "$f")"
if [ "$c" = "DENIED" ]; then echo "An error occurred (AccessDeniedException) when calling the operation: not allowed" >&2; exit 254; fi
printf '%s\\n' "$c"
`;
const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+00:00');
const param = (value, modified) => JSON.stringify({ Parameter: { Value: value, LastModifiedDate: modified } });
const hist = (...values) => JSON.stringify({ Parameters: values.map((Value) => ({ Value })) });
const STAGING_TAG = 'get-parameter_kesher_staging_deployed-image-tag';
const STAGING_MARKER = 'get-parameter_kesher_staging_deploy-in-progress';
const PROD_HISTORY = 'get-parameter-history_kesher_prod_deployed-image-tag';

maybe('prod gate: staging must have run the tag, alone, for an hour', () => {
  const gate = (files) =>
    withSandbox(SSM_STUB, (sb) => {
      for (const [k, v] of Object.entries(files)) sb.write(k, v);
      return sb.run('prod-gate.sh', [], { TAG });
    });

  assert.equal(gate({ [STAGING_TAG]: param(TAG, iso(2 * HOUR)) }).status, 0, 'two hours passes');
  assert.equal(gate({ [STAGING_TAG]: param(TAG, iso(HOUR + 2000)) }).status, 0, 'just over an hour passes');
  const young = gate({ [STAGING_TAG]: param(TAG, iso(30 * 60 * 1000)) });
  assert.equal(young.status, 1, 'half an hour fails');
  assert.match(young.stdout, /needs 3600/);
  // the CLI's epoch form of a timestamp
  const epoch = (msAgo) => String((Date.now() - msAgo) / 1000);
  assert.equal(gate({ [STAGING_TAG]: param(TAG, epoch(2 * HOUR)) }).status, 0, 'epoch timestamp, old');
  assert.equal(gate({ [STAGING_TAG]: param(TAG, epoch(60 * 1000)) }).status, 1, 'epoch timestamp, young');

  const other = gate({ [STAGING_TAG]: param(OTHER, iso(5 * HOUR)) });
  assert.equal(other.status, 1, 'staging on another tag fails');
  assert.match(other.stdout, new RegExp(`Staging runs ${OTHER}, not ${TAG}`));
  const none = gate({});
  assert.equal(none.status, 1, 'no staging record fails');
  assert.match(none.stdout, /no deployed-image-tag record/);
});

maybe('prod gate: an unfinished staging deploy blocks the tag, however old its earlier record', () => {
  const files = { [STAGING_TAG]: param(TAG, iso(9 * HOUR)), [STAGING_MARKER]: param(OTHER, iso(10 * 60 * 1000)) };
  const r = withSandbox(SSM_STUB, (sb) => {
    for (const [k, v] of Object.entries(files)) sb.write(k, v);
    return sb.run('prod-gate.sh', [], { TAG });
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`deploy of ${OTHER} to staging started and has not finished`));
});

maybe('prod gate: a read that fails for any reason but ParameterNotFound fails the gate', () => {
  const good = { [STAGING_TAG]: param(TAG, iso(5 * HOUR)) };
  const run = (files) =>
    withSandbox(SSM_STUB, (sb) => {
      for (const [k, v] of Object.entries(files)) sb.write(k, v);
      return sb.run('prod-gate.sh', [], { TAG });
    });
  assert.equal(run({ ...good }).status, 0);
  assert.equal(run({ ...good, [STAGING_TAG]: 'DENIED' }).status, 1, 'staging record AccessDenied');
  assert.equal(run({ ...good, [STAGING_MARKER]: 'DENIED' }).status, 1, 'staging marker AccessDenied');
  assert.equal(run({ ...good, [PROD_HISTORY]: 'DENIED' }).status, 1, 'prod history AccessDenied');
  assert.notEqual(run({ ...good, [STAGING_TAG]: 'not json' }).status, 0, 'garbage');
});

maybe('prod gate: a tag prod already ran may roll back, whatever staging runs', () => {
  const run = (files) =>
    withSandbox(SSM_STUB, (sb) => {
      for (const [k, v] of Object.entries(files)) sb.write(k, v);
      return sb.run('prod-gate.sh', [], { TAG });
    });
  const staging = { [STAGING_TAG]: param(OTHER, iso(5 * HOUR)) };
  assert.equal(run({ ...staging, [PROD_HISTORY]: hist(OTHER, TAG) }).status, 0, 'in prod history');
  assert.equal(run({ ...staging, [PROD_HISTORY]: hist(OTHER, TAG), [STAGING_MARKER]: param(OTHER, iso(HOUR)) }).status, 0, 'even with staging unsettled');
  assert.equal(run({ ...staging, [PROD_HISTORY]: hist('sha-aaaaaaaaaaaa') }).status, 1, 'a tag prod never ran does not');
  assert.equal(run({}).status, 1);
});

// -- check-account.sh --
const STS_STUB = 'cat "$STUB/account"';
maybe('check-account: Terraform, the CLI profile and the repository variables must name the same accounts', () => {
  const vars = (account, shared) => `account_id = "${account}"\nshared_account_id = "${shared}"\ntemporal_namespace = "x"\n`;
  const run = ({ tfvars, profile = '222222222222', expected = '222222222222', shared = '111111111111' }) =>
    withSandbox(STS_STUB, (sb) => {
      sb.write('account', profile);
      sb.write('tfvars', tfvars);
      return sb.run('check-account.sh', [path.join(sb.dir, 'tfvars')], { EXPECTED_ACCOUNT: expected, EXPECTED_SHARED: shared });
    });
  assert.equal(run({ tfvars: vars('222222222222', '111111111111') }).status, 0);
  const wrongTf = run({ tfvars: vars('999999999999', '111111111111') });
  assert.equal(wrongTf.status, 1);
  assert.match(wrongTf.stdout, /account_id \(999999999999\)/);
  const wrongProfile = run({ tfvars: vars('222222222222', '111111111111'), profile: '333333333333' });
  assert.equal(wrongProfile.status, 1);
  assert.match(wrongProfile.stdout, /answers as account 333333333333/);
  assert.equal(run({ tfvars: vars('222222222222', '888888888888') }).status, 1, 'shared account differs');
  assert.equal(run({ tfvars: 'shared_account_id = "111111111111"\n' }).status, 1, 'account_id missing');
  assert.equal(run({ tfvars: `${vars('222222222222', '111111111111')}account_id = "999999999999"\n` }).status, 1, 'account_id twice');
});

maybe('configure-profiles writes a deploy and a staging profile and refuses a bad account id', () => {
  withSandbox('', (sb) => {
    const env = { ENVIRONMENT: 'prod', STAGING_ACCOUNT: '222222222222', PROD_ACCOUNT: '333333333333', AWS_REGION: 'us-east-1', GITHUB_RUN_ID: '7', AWS_CONFIG_FILE: path.join(sb.dir, 'cfg') };
    assert.equal(sb.run('configure-profiles.sh', [], env).status, 0);
    const cfg = fs.readFileSync(path.join(sb.dir, 'cfg'), 'utf8');
    assert.match(cfg, /\[profile deploy\]\nrole_arn = arn:aws:iam::333333333333:role\/kesher-deploy/);
    assert.match(cfg, /\[profile staging\]\nrole_arn = arn:aws:iam::222222222222:role\/kesher-deploy/);
    assert.equal(sb.run('configure-profiles.sh', [], { ...env, PROD_ACCOUNT: '' }).status, 1);
    assert.equal(sb.run('configure-profiles.sh', [], { ...env, ENVIRONMENT: 'staging', STAGING_ACCOUNT: '12345' }).status, 1);
  });
});

// -- run-migrate.sh --
const CFG = JSON.stringify({ cluster: 'kesher-staging', task_definition: 'kesher-staging-migrate', container: 'migrate', network_configuration: { subnets: ['subnet-a'], security_groups: ['sg-1'], assign_public_ip: false } });
const migrateStub = (image = `111111111111.dkr.ecr.us-east-1.amazonaws.com/kesher/migrate:${TAG}`) => `
case "$2" in
  describe-task-definition) echo '{"taskDefinitionArn":"arn:td/migrate:9","containerDefinitions":[{"name":"migrate","image":"${image}"}]}' ;;
  run-task) echo '{"tasks":[{"taskArn":"arn:task/1"}],"failures":[]}' ;;
  describe-tasks)
    n=$(( $(cat "$STUB/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB/n"
    f="$STUB/describe_$n"; [ -f "$f" ] || f="$STUB/describe_last"
    if [ "$(cat "$f")" = "FAIL" ]; then echo "ThrottlingException" >&2; exit 254; fi
    cat "$f" ;;
  stop-task) echo '{}' ;;
  logs) echo "ok   roles" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;
const stopped = (exit) => JSON.stringify({ tasks: [{ lastStatus: 'STOPPED', stoppedReason: 'Essential container exited', containers: [{ name: 'migrate', ...(exit === undefined ? {} : { exitCode: exit }) }] }] });
const running = JSON.stringify({ tasks: [{ lastStatus: 'RUNNING', containers: [{ name: 'migrate' }] }] });

function migrate(files, extra = {}, image) {
  return withSandbox(migrateStub(image), (sb) => {
    sb.write('cfg.json', CFG);
    for (const [k, v] of Object.entries(files)) sb.write(k, v);
    const r = sb.run('run-migrate.sh', [path.join(sb.dir, 'cfg.json')], { TAG, GITHUB_RUN_ID: '42', POLL_SECONDS: '0', RETRY_SECONDS: '0', ...extra });
    return { ...r, calls: sb.calls() };
  });
}

maybe('run-migrate: exit 0 passes; any other exit code, or none, fails; the task is not stopped once it stopped itself', () => {
  const ok = migrate({ describe_1: running, describe_last: stopped(0) });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /exited 0/);
  assert.match(ok.calls, /run-task .*--task-definition arn:td\/migrate:9/);
  assert.match(ok.calls, /assignPublicIp":"DISABLED"/);
  assert.doesNotMatch(ok.calls, /stop-task/);

  const bad = migrate({ describe_last: stopped(1) });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /exited with 1/);
  assert.doesNotMatch(bad.calls, /stop-task/);

  const none = migrate({ describe_last: stopped(undefined) });
  assert.equal(none.status, 1, 'a container that never reported an exit code');
  assert.match(none.stdout, /exited with none/);
});

maybe('run-migrate: refuses a task definition that is not the new tag, before running anything', () => {
  const r = migrate({ describe_last: stopped(0) }, {}, `111111111111.dkr.ecr.us-east-1.amazonaws.com/kesher/migrate:${OTHER}`);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.calls, /run-task/);
});

maybe('run-migrate: transient describe-tasks failures are retried; persistent ones stop the task', () => {
  const transient = migrate({ describe_1: 'FAIL', describe_2: 'FAIL', describe_3: running, describe_last: stopped(0) });
  assert.equal(transient.status, 0, transient.stdout + transient.stderr);
  assert.doesNotMatch(transient.calls, /stop-task/);

  const dead = migrate({ describe_last: 'FAIL' });
  assert.equal(dead.status, 1);
  assert.match(dead.calls, /stop-task .*--task arn:task\/1/, 'the task is stopped when polling gives up');
});

maybe('run-migrate: a task that outlives the deadline is stopped', () => {
  const r = migrate({ describe_last: running }, { DEADLINE_SECONDS: '0' });
  assert.equal(r.status, 1);
  assert.match(r.calls, /stop-task/);
});

maybe('run-migrate: a cancelled run (SIGTERM) stops the task', async () => {
  const sb = sandbox(migrateStub());
  try {
    sb.write('cfg.json', CFG);
    sb.write('describe_last', running);
    const child = spawn('bash', [path.join(scriptDir, 'run-migrate.sh'), path.join(sb.dir, 'cfg.json')], { env: sb.env({ TAG, GITHUB_RUN_ID: '42', POLL_SECONDS: '1', RETRY_SECONDS: '0' }) });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 100 && !/describe-tasks/.test(sb.calls()); i += 1) await sleep(50);
    assert.match(sb.calls(), /describe-tasks/, 'the script reached its wait loop');
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.notEqual(code, 0);
    assert.match(sb.calls(), /stop-task/);
  } finally {
    sb.done();
  }
});

// -- check-services.sh --
const servicesStub = `
case "$2" in
  wait) [ -f "$STUB/wait_fails" ] && exit 255; exit 0 ;;
  describe-services) cat "$STUB/svc_$(printf '%s\\n' "$*" | sed -E 's/.*--services ([^ ]+).*/\\1/')" ;;
  describe-task-definition) cat "$STUB/td_$(printf '%s\\n' "$*" | sed -E 's/.*--task-definition ([^ ]+).*/\\1/' | tr '/:' '__')" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;
const svc = (deployments) => JSON.stringify({ services: [{ deployments }] });
const dep = (status, rolloutState, taskDefinition) => ({ status, rolloutState, taskDefinition });
const td = (...images) => JSON.stringify({ taskDefinition: { containerDefinitions: images.map((image) => ({ image })) } });
const REPO = '111111111111.dkr.ecr.us-east-1.amazonaws.com/kesher/api';

function services(files, names = { 'api-il': 'kesher-staging-api-il' }) {
  return withSandbox(servicesStub, (sb) => {
    sb.write('names.json', JSON.stringify(names));
    for (const [k, v] of Object.entries(files)) sb.write(k, v);
    return sb.run('check-services.sh', ['kesher-staging', path.join(sb.dir, 'names.json')], { TAG });
  });
}

maybe('check-services: one COMPLETED deployment on the tag passes; a rollback, a wrong image or two deployments fail', () => {
  const svcFile = 'svc_kesher-staging-api-il';
  const newTd = 'td_arn_td_api_2';
  const oldTd = 'td_arn_td_api_1';
  const good = services({ [svcFile]: svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:2')]), [newTd]: td(`${REPO}:${TAG}`) });
  assert.equal(good.status, 0, good.stdout + good.stderr);

  // the circuit breaker rolled back: stable, one COMPLETED deployment, but on the old task definition
  const rolledBack = services({ [svcFile]: svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:1')]), [oldTd]: td(`${REPO}:${OTHER}`) });
  assert.equal(rolledBack.status, 1);
  assert.match(rolledBack.stdout, /circuit breaker may have rolled it back/);

  assert.equal(services({ [svcFile]: svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:2')]), [newTd]: td(`${REPO}:${TAG}`, `${REPO}-sidecar:${OTHER}`) }).status, 1, 'one container on another image');
  assert.equal(services({ [svcFile]: svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:2'), dep('ACTIVE', 'COMPLETED', 'arn:td/api:1')]), [newTd]: td(`${REPO}:${TAG}`) }).status, 1, 'two deployments');
  assert.equal(services({ [svcFile]: svc([dep('PRIMARY', 'IN_PROGRESS', 'arn:td/api:2')]), [newTd]: td(`${REPO}:${TAG}`) }).status, 1, 'still rolling');
  assert.equal(services({ [svcFile]: svc([dep('PRIMARY', 'FAILED', 'arn:td/api:2')]), [newTd]: td(`${REPO}:${TAG}`) }).status, 1, 'failed rollout');
  assert.equal(services({ [svcFile]: svc([]) }).status, 1, 'no deployment');
  assert.equal(services({ [svcFile]: svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:2')]), [newTd]: td() }).status, 1, 'no containers');
  assert.equal(services({}, {}).status, 1, 'no services listed');
  assert.equal(services({ wait_fails: '1', [svcFile]: svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:2')]), [newTd]: td(`${REPO}:${TAG}`) }).status, 255, 'the stability wait times out (the CLI waiter failed)');
});

maybe('check-services: every service must pass, not only the first', () => {
  const names = { 'api-il': 'kesher-staging-api-il', worker: 'kesher-staging-worker' };
  const r = services(
    {
      'svc_kesher-staging-api-il': svc([dep('PRIMARY', 'COMPLETED', 'arn:td/api:2')]),
      td_arn_td_api_2: td(`${REPO}:${TAG}`),
      'svc_kesher-staging-worker': svc([dep('PRIMARY', 'COMPLETED', 'arn:td/worker:1')]),
      td_arn_td_worker_1: td(`${REPO}:${OTHER}`),
    },
    names,
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /kesher-staging-worker/);
  assert.match(r.stdout, /kesher-staging-api-il: stable on/);
});

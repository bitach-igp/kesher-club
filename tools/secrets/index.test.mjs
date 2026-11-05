// Tests for tools/secrets (T-0056). Run with `node --test tools/*.test.mjs tools/secrets/*.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll, GENERATED, kids } from './generate.mjs';
import { awsCalls, run, VALIDATORS } from './index.mjs';

const NO_VALUE = { status: 254, stderr: "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret value for VersionStage: AWSCURRENT" };
const NO_CONTAINER = { status: 254, stderr: "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret." };
const HAS_VALUE = { status: 0, stderr: '' };

/** A fake AWS CLI: remembers every call; `state` says what get-secret-value answers per secret id. */
function fakeAws(state) {
  const calls = [];
  const exec = (args, input) => {
    calls.push({ args, input });
    const id = args[args.indexOf('--secret-id') + 1];
    if (args[1] === 'get-secret-value') return state[id] ?? NO_VALUE;
    return { status: 0, stderr: '' };
  };
  return { exec, calls };
}

test('every generated value passes its own validator, and the admin key pair matches the staff JWKS', () => {
  const v = generateAll('staging');
  assert.deepEqual(Object.keys(v).sort(), [...GENERATED].sort());
  for (const name of GENERATED) assert.ok(VALIDATORS[name](v[name]), name);
  assert.notEqual(v['pii-data-key'], v['pii-index-key'], 'the process config refuses equal PII keys');
  const priv = JSON.parse(v['admin-api-signing-key']);
  const pub = JSON.parse(v['staff-jwks']).keys[0];
  assert.equal(pub.x, priv.x);
  assert.equal(pub.y, priv.y);
  assert.equal(pub.kid, kids('staging').admin);
  assert.equal(pub.d, undefined, 'the public JWKS carries no private part');
  assert.equal(JSON.parse(v['jwt-signing-key']).kid, kids('staging').jwt);
});

test('two runs generate different values', () => {
  const a = generateAll('prod');
  const b = generateAll('prod');
  for (const name of GENERATED) assert.notEqual(a[name], b[name], name);
});

test('loads a secret with no value, on stdin, and never in an argument', () => {
  const { exec, calls } = fakeAws({});
  const results = run({ env: 'staging', region: 'us-east-1', only: ['pii-data-key'] }, exec);
  assert.deepEqual(results, [{ name: 'pii-data-key', outcome: 'loaded' }]);
  const write = calls.find((c) => c.args[1] === 'put-secret-value');
  assert.equal(write.args.at(-1), 'file:///dev/stdin');
  assert.ok(VALIDATORS['pii-data-key'](write.input));
  for (const c of calls) assert.ok(!c.args.join(' ').includes(write.input), 'the value is in an argument');
});

test('keeps a secret that already has a value unless --rotate is given', () => {
  const state = { 'kesher/staging/pii-data-key': HAS_VALUE };
  const kept = fakeAws(state);
  assert.deepEqual(run({ env: 'staging', region: 'r', only: ['pii-data-key'] }, kept.exec), [{ name: 'pii-data-key', outcome: 'kept' }]);
  assert.ok(!kept.calls.some((c) => c.args[1] === 'put-secret-value'));
  const rotated = fakeAws(state);
  assert.deepEqual(run({ env: 'staging', region: 'r', only: ['pii-data-key'], rotate: true }, rotated.exec), [{ name: 'pii-data-key', outcome: 'rotated' }]);
});

test('--dry-run writes nothing and says what it would do', () => {
  const { exec, calls } = fakeAws({ 'kesher/prod/jwt-signing-key': HAS_VALUE });
  const results = run({ env: 'prod', region: 'r', only: ['jwt-signing-key', 'staff-jwks'], rotate: true, dryRun: true }, exec);
  assert.deepEqual(results.map((r) => r.outcome), ['would-rotate', 'would-load']);
  assert.ok(!calls.some((c) => c.args[1] === 'put-secret-value'));
});

test('a container Terraform has not created stops the run and names the secret; so does any other AWS error', () => {
  const missing = fakeAws({ 'kesher/staging/jwt-signing-key': NO_CONTAINER });
  assert.deepEqual(run({ env: 'staging', region: 'r', only: ['jwt-signing-key', 'pii-data-key'] }, missing.exec), [{ name: 'jwt-signing-key', outcome: 'no-container' }]);
  const denied = fakeAws({ 'kesher/staging/jwt-signing-key': { status: 255, stderr: 'AccessDeniedException' } });
  assert.deepEqual(run({ env: 'staging', region: 'r', only: ['jwt-signing-key'] }, denied.exec), [{ name: 'jwt-signing-key', outcome: 'failed' }]);
  assert.ok(!denied.calls.some((c) => c.args[1] === 'put-secret-value'));
});

test('refuses an unknown environment, an unknown secret and a missing region', () => {
  assert.throws(() => run({ env: 'dev', region: 'r' }, fakeAws({}).exec), /--env must be one of/);
  assert.throws(() => run({ env: 'staging', region: 'r', only: ['stripe-api-key'] }, fakeAws({}).exec), /Unknown secret stripe-api-key/);
  assert.throws(() => run({ env: 'staging', region: '' }, fakeAws({}).exec), /--region is required/);
});

test('awsCalls reads and writes the same secret id under the environment prefix', () => {
  const { read, write } = awsCalls('prod', 'pii-index-key', 'us-east-1');
  assert.ok(read.args.includes('kesher/prod/pii-index-key') && write.args.includes('kesher/prod/pii-index-key'));
});

test('the output of a run carries names and outcomes only', () => {
  const { exec } = fakeAws({});
  const values = generateAll('staging');
  const results = run({ env: 'staging', region: 'r' }, exec, () => values);
  const printed = results.map((r) => `${r.outcome} ${r.name}`).join('\n');
  for (const name of GENERATED) assert.ok(!printed.includes(values[name]));
});

#!/usr/bin/env node
// Crowded webhook subscriptions (T-0655): list, create and delete the registrations that point Crowded at our
// receiver (POST /v1/webhooks/crowded, T-0649). Run by a person on the desktop, never from CI.
//
//   node tools/crowded-webhooks.mjs list   [--dry-run]
//   node tools/crowded-webhooks.mjs create --url https://webhooks.example/webhooks/crowded [--dry-run]   (the webhook host's edge forwards /webhooks/*)
//   node tools/crowded-webhooks.mjs delete --id <webhookId> --yes [--dry-run]
//
// Environment (never printed, never logged):
//   CROWDED_API_TOKEN       bearer token for the management API (required except with --dry-run)
//   CROWDED_BASE_URL        e.g. https://sandbox-api.crowdedfinance.com/api/v1 (required; there is no production default)
//   CROWDED_WEBHOOK_SECRET  the endpoint secret we verify with (32-128 chars of A-Za-z0-9_-+/=); on create we send
//                           ours, so the secret Crowded would generate is never needed and never shown.
// --dry-run prints the request it would make, with the token and secret replaced by <redacted>, and sends nothing.
const EVENTS = [
  'collect.collection.created', 'collect.collection.updated', 'collect.collection.canceled',
  'collect.intent.created', 'collect.intent.updated',
  'collect.payment.pending', 'collect.payment.processing', 'collect.payment.succeeded', 'collect.payment.failed', 'collect.payment.canceled', 'collect.payment.returned', 'collect.payment.refunded',
  'collect.refund.initiated', 'collect.refund.processing', 'collect.refund.reversed',
  'finance.application.submitted', 'finance.application.approved', 'finance.application.denied',
  'finance.account.created', 'finance.account.updated', 'finance.account.closed',
  'finance.transaction.created',
  'finance.ach_payment.processing', 'finance.ach_payment.sent', 'finance.ach_payment.returned', 'finance.ach_payment.canceled', 'finance.ach_payment.failed',
];

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const dry = flag('dry-run');
const base = (process.env.CROWDED_BASE_URL ?? '').replace(/\/+$/, '');
const token = process.env.CROWDED_API_TOKEN ?? '';
const secret = process.env.CROWDED_WEBHOOK_SECRET ?? '';

if (!['list', 'create', 'delete'].includes(cmd ?? '')) die('usage: crowded-webhooks.mjs list | create --url <https url> | delete --id <id> --yes   [--dry-run]');
if (!/^https:\/\/[^/]+/.test(base)) die('CROWDED_BASE_URL must be an https URL (there is no production default)');
if (!dry && !token) die('CROWDED_API_TOKEN is not set');

let request;
if (cmd === 'list') request = { method: 'GET', path: '/webhooks' };
else if (cmd === 'create') {
  const url = value('url') ?? '';
  if (!/^https:\/\/[^/\s]+(\/v1)?\/webhooks\/crowded$/.test(url)) die('--url must be https and end in /webhooks/crowded (or /v1/webhooks/crowded)');
  if (!/^[A-Za-z0-9_\-+/=]{32,128}$/.test(secret)) die('CROWDED_WEBHOOK_SECRET must be 32-128 characters of A-Za-z0-9_-+/=');
  request = { method: 'POST', path: '/webhooks', body: { url, events: EVENTS, deliveryMode: 'at_least_once', description: 'Kesher receiver', secret } };
} else {
  const id = value('id') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) die('--id must be a webhook id');
  if (!flag('yes') && !dry) die('delete is permanent at Crowded: pass --yes');
  request = { method: 'DELETE', path: `/webhooks/${id}` };
}

const redact = (body) => (body ? { ...body, ...(body.secret ? { secret: '<redacted>' } : {}) } : undefined);

if (dry) {
  console.log(JSON.stringify({ dryRun: true, method: request.method, url: base + request.path, headers: { Authorization: 'Bearer <redacted>', 'Content-Type': 'application/json' }, body: redact(request.body) }, null, 2));
  process.exit(0);
}

const res = await fetch(base + request.path, {
  method: request.method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  signal: globalThis.AbortSignal.timeout(15_000),
});
const text = await res.text();
let out;
try {
  out = text ? JSON.parse(text) : null;
} catch {
  out = { unparsed: text.slice(0, 200) };
}
// Never print a secret or an authorization header the provider echoes back.
const scrub = (v) => (Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /secret|authorization/i.test(k) ? '<withheld>' : scrub(x)])) : v);
console.log(JSON.stringify({ status: res.status, body: scrub(out) }, null, 2));
if (!res.ok) process.exit(1);

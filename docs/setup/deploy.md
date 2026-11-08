# Smoke test of a deployed environment

`tools/smoke` (T-0051) answers one question after a deploy: does this environment work. It is plain Node (22 or later, no install step).
It talks to the environment over HTTPS only, sends GET, HEAD and deliberately invalid requests, and never creates data. It stops at the
first failure, names the check and exits 1.

## Run it

A command that can pass today (the tag and OpenAPI checks skip, the console `/healthz` check is left out because the console has none yet):

```sh
node tools/smoke/index.mjs \
  --base-url https://api-il.staging.<domain> \
  --jit-url https://jit-il.staging.<domain> \
  --admin-url https://admin.staging.<domain> \
  --web-url https://app.staging.<domain>
```

The strict gate the card aims at, which **cannot pass today**:

```sh
node tools/smoke/index.mjs --strict \
  --base-url https://api-il.staging.<domain> --jit-url https://jit-il.staging.<domain> \
  --admin-url https://admin.staging.<domain> --console-url https://console.staging.<domain> \
  --web-url https://app.staging.<domain> --openapi-url https://api-il.staging.<domain>/<openapi path> \
  --expected-tag sha-0123456789ab
```

It fails today for three reasons, each a follow-up: `api-tag` skips because the API reports no deployed tag; `openapi-operations`
has no document to read because the API serves none; and `console-healthz` fails because the console has no `/healthz` until T-0047.
`webhook-bad-signature` also skips (so fails under `--strict`) while the flag `institutions.usBanking` is off, which is its default.
Do not wire `--strict` into a deploy gate until those land.

`--base-url` is the API host and is the only required option. Every option has an environment variable, and a flag wins over it:

| Option | Variable | Meaning |
|---|---|---|
| `--base-url` | `SMOKE_BASE_URL` | the API host (`https://` origin) |
| `--jit-url` | `SMOKE_JIT_URL` | the card-authorisation host |
| `--admin-url` | `SMOKE_ADMIN_URL` | the admin host, tried from outside the VPN |
| `--console-url` | `SMOKE_CONSOLE_URL` | the institution console host |
| `--web-url` | `SMOKE_WEB_URL` | the parent portal host |
| `--openapi-url` | `SMOKE_OPENAPI_URL` | where the environment serves its OpenAPI document |
| `--expected-tag` | `SMOKE_EXPECTED_TAG` | the image tag the deploy just rolled out (`sha-<12 characters>`, `docs/setup/release.md`) |
| `--webhook-path` | `SMOKE_WEBHOOK_PATH` | the webhook route used for the bad-signature check, default `/v1/webhooks/crowded` |
| `--strict` | `SMOKE_STRICT=1` | a skipped check counts as a failure |
| `--allow-local` | `SMOKE_ALLOW_LOCAL=1` | accept `http://` for localhost, 127.0.0.1 and [::1] only (the unit tests; a developer's machine) |

Output is one line per check, `PASS`, `SKIP` or `FAIL`, then a summary. `http://` is refused for every other host, as are URLs with a
user name or password. A check whose URL was not given is skipped. `--strict` and every URL stop a skipped check from hiding a missing host. Run it from outside the VPN: the admin check needs that to mean anything. The TLS check connects
directly with `node:tls` and does not go through an HTTP proxy.

## The checks

| Check | What it does | What a pass means |
|---|---|---|
| `api-status` | `GET /v1/status` on the API host | 200, and the five capabilities (`wallet`, `card`, `p2p`, `fx`, `payouts`) each read `ok`, `degraded` or `off`. A flag that is off is not a failure; a broken body or a non-200 is. |
| `api-tag` | compares `--expected-tag` with the tag the API reports | the running build is the one just deployed. See Deviations: the API reports none today. |
| `openapi-operations` | fetches `--openapi-url` and counts operations (paths times methods) | the served document has as many operations as `contracts/openapi.yaml` in this checkout. Run it from the commit that was deployed. |
| `api-tls13-only` | `node:tls` handshake with `maxVersion: TLSv1.2`, then with `minVersion: TLSv1.3` | TLS 1.2 is refused with a protocol-version alert and TLS 1.3 is negotiated on the API host. Any other error on the first handshake (DNS, connect, certificate) is a failure: it does not show TLS 1.2 is refused. |
| `jit-health` | `GET /v1/status` on the JIT host | 200 with `{"role":"jit","status":"ok"}`: the process is the authorisation role, not a second API. |
| `admin-closed-outside-vpn` | resolves the admin host, then `GET /` | the name resolves, and the answer is 403, a refused or reset connection, or a timeout. A name that does not resolve, any other status (2xx, a redirect, 401, 404, 5xx) or any other error fails: only an explicit refusal proves the door is shut. |
| `console-healthz` | `GET /healthz` on the console host | 200. |
| `web-security-headers` | `GET /` on the web host | `Strict-Transport-Security` with max-age of at least 15552000 (180 days); `X-Content-Type-Options: nosniff`; frame protection (`X-Frame-Options` DENY or SAMEORIGIN, or a CSP `frame-ancestors`); a `Content-Security-Policy` header. A failure lists every missing one. The list is the floor for a site that serves pages; it does not judge the CSP's content. |
| `webhook-bad-signature` | POSTs one forged delivery (a wrong signature) to `--webhook-path`, after checking the path stays on the API origin | exactly 401 with problem code `invalid_signature`. A 404 (the route sits behind the flag `institutions.usBanking`, default off, and answers `FEATURE_OFF` before it looks at the signature; or the path is wrong) is a SKIP, because no refusal was proven. A 2xx or any other answer fails. That a refused delivery claims no event id (T-0207) is not visible from outside and is proved by the API's own tests, not here. |
| `money-route-needs-auth` | `GET /v1/accounts` with no bearer | 401. |

## What it can and cannot do to the environment

- The client has no PUT, PATCH or DELETE. A POST goes through one function reserved for invalid requests, and `smoke.test.mjs` records
  every request the suite makes and fails on anything else.
- It sends no credential: the client refuses an `Authorization`, `Cookie`, `X-Api-Key` or similar header, so nothing it sends can authenticate.
- The forged webhook is the one request with a side effect, and only when the route is live (flag on): the API keeps a record of
  the refused delivery for forensics (`ops.inbound_rejected`: a hash, never the body). It is not an event and moves no money.
  With the flag off the route answers 404 and stores nothing.

## Deviations from the card (T-0051)

- **The API reports no deployed tag.** `GET /v1/status` returns the capabilities and an optional incident only, and nothing sets a
  version header. `apps/api` is outside the card's files, so the tag check reads `x-kesher-version` or a `version` or `tag` field in the
  status body if the API ever sends one, and otherwise SKIPs with that message (a failure under `--strict`). A follow-up should
  have the API return its `IMAGE_TAG`.
- **The API serves no OpenAPI document.** The same reasoning: `openapi-operations` needs `--openapi-url`, and skips without it.
- **The console has no `/healthz` yet** (only the admin app does); the check fails against a console that lacks it until that exists.

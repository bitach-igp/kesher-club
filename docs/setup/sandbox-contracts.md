# Sandbox contract runs (T-0690)

Every adapter passes its port's contract suite on each PR against an in-memory fake. A fake cannot notice a vendor changing its
sandbox, so `.github/workflows/sandbox-contract.yml` runs the suites that can run unattended against the real sandboxes, nightly at
03:17 UTC and on demand (Actions tab, "sandbox-contract", Run workflow).

## How it behaves

- Runs on a schedule and on `workflow_dispatch` only. There is no `pull_request` trigger, so a fork never reaches the secrets, and
  each job also refuses a forked repository.
- One job per port. A job runs its suite only when every required secret for it is set; otherwise it prints a notice ("no sandbox key
  yet") and succeeds. A port with no key is a skip, never a red run.
- A failing suite opens an issue titled `Sandbox contract failing: <port>` (port is `stripe`, `twilio`, `postmark`, `expo` or
  `crowded`), or comments on the open one with that title. Close the issue once the suite is green again. The workflow sets no
  labels. Permissions are `contents: read` for every job and `issues: write` only on the port jobs.
- No key here may be a live key: Stripe takes a test-mode key (`sk_test_` / `rk_test_`; the suite refuses anything else), Twilio test
  credentials or a trial account, Postmark an `POSTMARK_API_TEST` server token or a sandbox server, Expo any well-formed token.

## Secret names

Add them under Settings, Secrets and variables, Actions, as repository secrets. The names are the environment variables the tests
read. "Required" means the job skips unless all of them are set.

| Port (job) | Required secrets | Optional secrets | Suite |
|---|---|---|---|
| `stripe` | `STRIPE_SANDBOX_SECRET_KEY`, `STRIPE_SANDBOX_BILLING_WEBHOOK_SECRET` | | `Stripe sandbox smoke` in `packages/adapters/src/sandbox.contract.test.ts` |
| `twilio` | `SANDBOX_TWILIO_ACCOUNT_SID`, `SANDBOX_TWILIO_AUTH_TOKEN`, `SANDBOX_TWILIO_FROM`, `SANDBOX_TWILIO_TO` | | `NotifyPort contract: twilio sandbox` |
| `postmark` | `SANDBOX_POSTMARK_SERVER_TOKEN`, `SANDBOX_POSTMARK_FROM`, `SANDBOX_POSTMARK_ALIAS`, `SANDBOX_POSTMARK_TO` | | `NotifyPort contract: postmark sandbox` |
| `expo` | `SANDBOX_EXPO_PUSH_TOKEN` | `SANDBOX_EXPO_ACCESS_TOKEN` | `NotifyPort contract: expo sandbox` |
| `crowded` | `CROWDED_SANDBOX_TOKEN` | `CROWDED_BASE_URL` (defaults to the sandbox host) | `packages/adapters/src/crowded/sandbox.test.ts` |

The workflow also uses the built-in `GITHUB_TOKEN` (to file issues); it is not something to add.

## Ports with no sandbox suite yet

Airalo, Cover Genius, WorkOS and Apple/Google sign-in have contract suites against their fakes only. No test reads a sandbox
credential for them, so this workflow has nothing to run and lists them in a notice. When one gains a sandbox suite, add its job
to the workflow, its secret names to the table above and to `tools/release/sandbox-contract-workflow.test.mjs`'s expectations.
(`packages/adapters/README.md` names the vendor credentials those adapters take in production; those are not Actions secrets here.)

# apps/web

The public static site on `app.<domain>` (T-0048): a minimal landing page, a support contact, the versioned legal pages and the
domain-association files that passkeys, universal links and Apple Pay need. A Next.js static export (`output: 'export'`): no server,
no cookies, no analytics, no third-party scripts, no web fonts. (The parent portal is out of scope; funders use the app.)

## Pages

| URL | What |
|---|---|
| `/` | Landing, English and Hebrew, links to support and the legal index |
| `/support` | `mailto:` link; the address is the constant `SUPPORT_EMAIL` in `src/site-config.ts` |
| `/legal` | Index of the documents in force |
| `/legal/<docKey>` | One page per kind: `terms`, `privacy`, `cardholder`, `esim`, `insurance`, `p2p`, `funder` |
| `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` | Rendered from `src/app-ids.ts` |
| `/.well-known/apple-developer-merchantid-domain-association` | Stripe's Apple Pay file, from `STRIPE_APPLE_PAY_DOMAIN_FILE` |

### Legal URL shape (decision)

The app links `/legal/<docKey>?lang=<locale>` (`apps/mobile/src/consent.ts`, from `EXPO_PUBLIC_LEGAL_BASE_URL`). A static host ignores the
query, so there is ONE page per `docKey` with both languages in the HTML (each in a `<section lang dir>`), and `public/lang.js` (same
origin, 10 lines) reads `?lang=` and shows that language and sets `<html lang dir>`. Without JavaScript both languages show, one after
the other. The query is a display hint only. Because CloudFront has no rewrite, the deploy uploads `legal/terms.html` under the key
`legal/terms` as well. Documents are rendered at build time as plain text (React text nodes, `white-space: pre-wrap`): nothing in a body is parsed.

## Build configuration (read at build, missing means the build fails)

| Variable | Meaning |
|---|---|
| `WEB_ENV` | `local`, `staging` or `production`. Outside `local` the build refuses placeholders. |
| `LEGAL_API_URL` | API base with `/v1`; the build fetches `${LEGAL_API_URL}/legal/documents`. https outside `local`. |
| `STRIPE_APPLE_PAY_DOMAIN_FILE` | Path of the file Stripe issued for the domain. Required in production, optional otherwise, absent in dev. |

The build FAILS (fail closed) if the fetch fails, the answer is malformed, or any of the seven kinds has no published version.

```sh
pnpm --filter @kesher/tokens build
WEB_ENV=local LEGAL_API_URL=http://localhost:3000/v1 pnpm --filter @kesher/web build   # writes apps/web/out
WEB_ENV=local LEGAL_API_URL=http://localhost:3000/v1 pnpm --filter @kesher/web dev
```

`pnpm build` at the repository root also builds this app and so needs these variables.

## Placeholders T-0058 must set

`src/app-ids.ts` holds `iosBundleId`, `appleTeamId`, `androidPackage`, `androidCertSha256` as PLACEHOLDERS (none is invented), and
`src/site-config.ts` holds `SUPPORT_EMAIL` as a placeholder. A `staging` or `production` build fails naming each field until they are real
(Team ID: 10 upper-case alphanumerics; fingerprint: 32 colon-separated hex bytes). The values must equal `apps/mobile/app.json` (T-0058).

## Deploy

`.github/workflows/deploy-web.yml` (manual, `staging` or `prod`): builds, assumes the deploy role through OIDC, uploads `out/` with explicit
content types and cache control, invalidates CloudFront. GitHub environment variables: `LEGAL_API_URL`, `WEB_BUCKET`,
`WEB_DISTRIBUTION_ID` (from `terraform output web_bucket_name` / `web_distribution_id`), and for prod `STRIPE_APPLE_PAY_DOMAIN_FILE_CONTENT`.
`apple-app-site-association` has no extension and is uploaded as `application/json`.

## Known limits

- `module.web`'s CSP is `script-src 'self'`; Next's small inline bootstrap scripts are blocked by it. The pages are complete static HTML and
  need no hydration, so nothing visible depends on them. Do not add interactive components without changing the CSP.
- The 403/404 to `/index.html` rule in the CDN means an unknown path shows the landing page with status 200.

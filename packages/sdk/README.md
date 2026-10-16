# @kesher/sdk

TypeScript client generated from `contracts/openapi.yaml` (T-0007). The contract is the source of
truth: edit the YAML, then `pnpm --filter @kesher/sdk generate` regenerates `src/schema.generated.ts`
(committed; a test fails when it drifts).

```ts
import { createClient, ApiError } from '@kesher/sdk';
import { fromWire, toWire, money } from '@kesher/domain';

const api = createClient({
  baseUrl: 'https://api.kesher.example/v1',
  getAccessToken: () => session.accessToken,
  getStepUpToken: () => stepUp.freshToken(),   // asked only for money operations (REQ-AUTH-006)
});

const t = await api.post('/transfers', {
  idempotencyKey: draft.key,                    // reuse on retry (REQ-PAY-005)
  body: { toPartyId, amount: toWire(money(5000n, 'ILS')) },
});
```

- Every operation that declares `Idempotency-Key` or `X-Step-Up` in the contract gets the header
  automatically; the table in `client.ts` is checked against the YAML by a test.
- Errors are `ApiError` with the closed `code` set from `@kesher/domain`; non-problem failures
  (gateway HTML) still become typed errors.
- Money is `{ minor: string; currency }` on the wire; convert with `fromWire` / `toWire`.
- Schemathesis fuzzes every path against the preview environment in `.github/workflows/preview.yml`.

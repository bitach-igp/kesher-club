---
name: club-openapi
description: Add or change an endpoint in contracts/openapi.yaml for Kesher Club with operationId, problem+json errors, the idempotency rule, bigint-safe Money, and an MCP tool entry when an agent scope is given. Use whenever an API path, request or response schema changes.
---

# Club OpenAPI

`contracts/openapi.yaml` (OpenAPI 3.1) is the API's source of truth. Code and the SDK follow it, never the reverse.

## Adding a path
1. **operationId**: lowerCamelCase verb + noun, unique (`createTransfer`, `getCapabilities`).
2. **summary** one line; **description** cites the REQ ids it implements (`REQ-PAY-001`).
3. **security** `[{ bearer: [] }]` unless the path is public on purpose (say why in the description).
4. **Mutating money or account calls** (move money, create cards, change limits) MUST take `- $ref: "#/components/parameters/IdempotencyKey"`. Money actions also state "Requires a step-up token younger than 5 minutes (REQ-AUTH-006)".
5. **Responses**: the success code with a `$ref` schema, plus `default: { $ref: "#/components/responses/Problem" }`. Never ad-hoc error bodies.
6. **Money** is always `$ref: "#/components/schemas/Money"` (`minor` as a decimal string, `currency` USD|ILS). Never a JSON number for amounts.
7. **New error code?** Add it to `Problem.code`'s enum AND to `packages/domain/src/errors.ts` in the same change.
8. Lists are cursor-paginated: `cursor` query param in, `{ items, nextCursor }` out.
9. Breaking changes (removed field, narrowed enum, new required input) go to a `/v2` path.

## MCP tool entry (only when an agent scope is given)
Append a row to `contracts/mcp-tools.md`:

| Tool | Tier | Scope | Returns / effect | Operation |
|---|---|---|---|---|
| `get_balances` | T0 | `balances:read` | Purses per member the grant covers | getBalances |

- snake_case tool names. Tier: T0 read, T1 reversible write, T2 money (creates a pending intent a human approves with a passkey; constitution art. 7).
- A T2 tool never moves money itself. Text from merchants or users is returned in an `untrusted` field.

## Check
```
npx --yes @stoplight/spectral-cli@6.15.0 lint contracts/openapi.yaml --ruleset .spectral.yaml
```
Must be clean (CI runs the same). List new error codes and MCP rows in your reply.

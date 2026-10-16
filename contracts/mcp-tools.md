# MCP tool catalogue

Mirror of Tab 3 §5 "MCP tool catalogue". `club-openapi` appends a row when a path gets an agent scope. T2 tools never move money: they create a pending intent a human approves with a passkey.

| Tool | Tier | Scope | Returns / effect | Operation |
|---|---|---|---|---|
| `get_balances` | T0 | `balances:read` | Purses per member the grant covers | — |
| `list_transactions` | T0 | `transactions:read` | Last 90 days, filters; merchant text in an `untrusted` field | — |
| `spending_summary` | T0 | `transactions:read` | Totals by category and week, in ₪ and $ | — |
| `get_card_status` | T0 | `card:status:read` | Status, controls (no card data) | — |
| `get_esim_usage` | T0 | `esim:read` | Data left, expiry | — |
| `freeze_card` / `unfreeze_card` | T1 | `card:freeze` | Immediate; unfreeze requires in-app confirmation | — |
| `propose_limit_change` | T1 | `limits:propose` | Creates a pending intent | — |
| `propose_p2p` | T2 | `p2p:propose` | Creates a pending intent; human approves with a passkey | — |
| `propose_load` | T2 | `load:propose` | Creates a pending intent for the funder | — |

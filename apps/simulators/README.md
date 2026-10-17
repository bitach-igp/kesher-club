# apps/simulators

Stateful simulator host with a control panel for every port (T-0009). One instance of each
simulator from `@kesher/ports`, one shared advanceable clock, bound in a `ProviderRegistry` for
US and IL in `sim` mode.

```
SIMULATOR_PORT=4010 NODE_ENV=development DATABASE_URL=postgres://x TEMPORAL_ADDRESS=localhost:7233 PROVIDER_MODE_DEFAULT=sim \
  pnpm --filter @kesher/simulators start
```

| Endpoint | What |
|---|---|
| `GET /` | HTML control panel: fixtures and hooks per port, clock controls |
| `GET /ports` | The port catalogue with `running` per port |
| `GET /ports/{capability}` | Fixtures, hooks and the current binding |
| `POST /ports/{capability}/hooks/{hook}` | Run a control hook (e.g. `billing/failInvoice`, `kyc/decide`); JSON body = hook args |
| `POST /clock/advance` | `{ "ms": 60000 }` moves every simulator's clock |
| `GET /health` | Clock and start time |

Hook results are bigint-safe JSON (Money minor units as strings). The host refuses to boot when
`NODE_ENV` is staging or production.

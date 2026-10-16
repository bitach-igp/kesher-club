# Skills in this repo

Claude Code (local and cloud sessions) loads project skills from `.claude/skills/<name>/SKILL.md`. Folders here with `.claude-plugin/plugin.json` load as project plugins wherever Claude Code loads plugins.

| Skill | Kind | Source | Use |
|---|---|---|---|
| `club-requirements` | house | this repo | REQ rows with GWT + flag column |
| `club-openapi` | house | this repo | API paths, problem+json, idempotency, MCP tool rows |
| `club-ddl` | house | this repo | Forward-only migrations that obey the constitution |
| `club-adapter` | house | this repo | Ports, simulators, contract suites, vendor adapters |
| `club-task-slicer` | house | this repo | REQ → task cards (≤1 day, ≤400 lines) |
| `club-runbook` | house | this repo | Runbooks from an alert |
| `spec-kit` | vendored templates | github/spec-kit @ f6e72bc (MIT) | Spec / plan / tasks templates |
| `property-based-testing` | vendored skill | trailofbits/skills @ 5c99c03 (CC-BY-SA-4.0) | Ledger and money invariant tests (fast-check) |
| `supply-chain-risk-auditor` | vendored skill with scripts | trailofbits/skills @ 5c99c03 (CC-BY-SA-4.0) | Dependency review before money flags go on |
| `insecure-defaults` | vendored plugin (command + workflow) | trailofbits/skills @ 5c99c03 (CC-BY-SA-4.0) | `/insecure-defaults:audit` before `wallet.enabled` |
| `spec-to-code-compliance` | vendored plugin (skill + workflow) | trailofbits/skills @ 5c99c03 (CC-BY-SA-4.0) | Release gate: live spec vs code |

## Vendoring notes
- Trail of Bits material is CC-BY-SA-4.0 (© Trail of Bits and contributors); each copy carries its LICENSE. Change made when vendoring: the `evals/`, `tests/` and `evals-extra/` folders were left out. Nothing else was edited.
- Spec Kit templates are MIT (© GitHub); LICENSE included.
- `supply-chain-risk-auditor` pre-approves `Bash` and runs Python scripts that call public advisory APIs; `insecure-defaults` pre-approves `Bash` and `Workflow`. Review `allowed-tools` before running them locally, and run Trail of Bits audits in a devcontainer or cloud session with no production secrets.
- The workflow-based plugins need Claude Code's workflow support; without it their commands report that they cannot run.
- To bump a pin: `tools/vendor-skills.sh <tob-sha> <speckit-sha>`, review `git diff -- .claude/skills`, then update `.agents/skills.lock.md`.

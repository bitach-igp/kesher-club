---
name: club-ddl
description: Write forward-only Postgres migrations for Kesher Club that obey the constitution - insert-only ledger, no UPDATE/DELETE grants on ledger.*, UUIDv7 ids, timestamptz, bigint minor units, vendor ids only in ops.external_ref. Use for any schema change, new table, index, role grant or migration.
---

# Club DDL

Migrations live in `db/migrations/<schema>/NNNN_<slug>.sql` (Atlas, forward-only). Roles come from `db/roles.sql`: `club_migrator` runs migrations, `club_app` runs the service.

## Rules (constitution art. 3, 9)
1. **Forward-only.** Never edit a merged migration; fix with a new one. Dropping a column that holds data takes two releases: stop writing, migrate, then drop.
2. **Ids**: `uuid primary key`, no default; the app generates UUIDv7. High-volume child rows may use `bigint generated always as identity` (as `ledger.posting` does).
3. **Time**: `timestamptz` everywhere. Never `timestamp` or epoch integers.
4. **Money**: `amount_minor bigint` + a `currency` column of type `ledger.currency`. Never `numeric`, `float` or `money`.
5. **Ledger is insert-only.** For `ledger.*`: `grant select, insert` to `club_app` only. Never `update`/`delete`; corrections are reversing journals. Keep the balance trigger intact.
6. **No soft deletes** (`deleted_at`). Closure is a state change or a separate table.
7. **Vendor ids** only in `ops.external_ref (entity_type, entity_id, provider, external_id)`. No vendor columns on domain tables.
8. **PII** columns are field-level encrypted (`bytea`, app-side envelope encryption) and listed in the PII classes table (Tab 3 §6). Never store KYC images.
9. Index every FK. Enums are Postgres enum types in the owning schema.
10. One concern per migration, with a header naming the task and REQs: `-- T-0201 ledger core (REQ-LED-001, REQ-LED-002)`.

## Test it
Ledger migrations need a database-level test: an unbalanced journal is rejected, and `club_app` gets `permission denied` on `UPDATE ledger.posting`. PGlite 0.2.x runs these in-process (0.3.x crashed on `RAISE` in our runs).

## Before you finish
- [ ] New file with the next number; no edits to old migrations
- [ ] Grants reviewed: only select/insert on `ledger.*` for `club_app`
- [ ] Types: uuid / timestamptz / bigint minor + currency
- [ ] Test added or updated

// Atlas configuration (T-0005, T-0011, T-0012). One migration directory per schema, applied by
// club_migrator. Usage (from the repo root):
//   node db/migrate.mjs --url "$ATLAS_URL"      # every schema, in dependency order (see below)
//   atlas migrate hash   --dir file://db/migrations/ledger
//   node db/lint.mjs                            # house rules + Squawk (destructive/locking changes)
// Do not apply with `--env local`: Atlas runs for_each envs in alphabetical order (addons before
// ledger); db/migrate.mjs honours the order below. Migration safety lint is Squawk (T-0012), not
// `atlas migrate lint`, which is Atlas Pro only since v0.38. The envs below hold the per-schema
// settings. The app role (club_app) never runs migrations; see db/roles.sql.

variable "url" {
  type        = string
  description = "Database URL for club_migrator. Never a fallback: export ATLAS_URL or pass --var url=…"
  default     = getenv("ATLAS_URL")
}

locals {
  // Dependency order, honoured by db/migrate.mjs (for_each below does NOT honour it; toset sorts).
  // Keep in step with SCHEMA_ORDER in db/migrate.mjs and apps/api/src/test-db.ts (a test compares them).
  schemas = ["ledger", "identity", "org", "billing", "legal", "addons", "notify", "audit", "agent"]
}

// Dev database for `migrate diff`, isolated in Docker so a diff can never touch real data.
locals {
  dev_url = "docker://postgres/16/dev?search_path=public"
}

env "local" {
  for_each = toset(local.schemas)
  url      = var.url
  dev      = local.dev_url
  migration {
    dir              = "file://db/migrations/${each.value}"
    revisions_schema = "atlas_${each.value}"
    // Forward-only: a changed or deleted historical file fails the checksum check.
    format = atlas
  }
}

env "preview" {
  for_each = toset(local.schemas)
  url      = var.url
  dev      = local.dev_url
  migration {
    dir              = "file://db/migrations/${each.value}"
    revisions_schema = "atlas_${each.value}"
  }
}

env "staging" {
  for_each = toset(local.schemas)
  url      = var.url
  dev      = local.dev_url
  migration {
    dir              = "file://db/migrations/${each.value}"
    revisions_schema = "atlas_${each.value}"
  }
  // Staging and prod only ever run the expand step from CI; contract steps are a second, later release.
}

env "prod" {
  for_each = toset(local.schemas)
  url      = var.url
  dev      = local.dev_url
  migration {
    dir              = "file://db/migrations/${each.value}"
    revisions_schema = "atlas_${each.value}"
    // Prod applies exactly one planned baseline at a time; `--baseline` is passed by the release job.
  }
}

// Atlas configuration (T-0005). One migration directory per schema, applied by club_migrator.
// Usage (from the repo root):
//   atlas migrate apply  --env local            # every schema, in order
//   atlas migrate lint   --env local --latest 1 # destructive-change and checksum lint
//   atlas migrate hash   --dir file://db/migrations/ledger
// The app role (club_app) never runs migrations; see db/roles.sql.

variable "url" {
  type        = string
  description = "Database URL for club_migrator. Never a fallback: export ATLAS_URL or pass --var url=…"
  default     = getenv("ATLAS_URL")
}

locals {
  // Order matters: later schemas reference earlier ones.
  schemas = ["ledger", "identity", "org", "billing", "legal", "addons", "notify", "audit", "agent"]
}

// Dev database for `migrate diff` and lint, isolated in Docker so a lint can never touch real data.
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
  lint {
    // Expand/contract: a destructive statement needs an explicit `-- atlas:nolint destructive` after review.
    destructive {
      error = true
    }
    data_depend {
      error = true
    }
    incompatible {
      error = true
    }
    naming {
      error   = true
      match   = "^[a-z][a-z0-9_]*$"
      message = "snake_case only"
    }
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
  lint {
    destructive {
      error = true
    }
  }
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
  lint {
    destructive {
      error = true
    }
  }
}

# T-0026: staging and prod run one api, jit and worker service per market (Zvi, 2026-10-19), all from the
# same image tag with MARKET set to the service's own market, on per-market hosts behind the existing
# ALBs. The database, KMS keys and secrets stay shared. Providers are mocked, so nothing reaches AWS. A
# mocked plan cannot know the ACM validation records a real plan would, so each root first applies its
# certificate alone (against the mocks), the way a first real apply would converge with -target.

# ARNs are validated at plan time, so the partition, region and account the mocks return must be real-looking.
mock_provider "aws" {
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:il-central-1:111111111111:certificate/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_acm_certificate_validation" {
    defaults = { certificate_arn = "arn:aws:acm:il-central-1:111111111111:certificate/00000000-0000-0000-0000-000000000000" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_region" {
    defaults = { name = "il-central-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
}

mock_provider "aws" {
  alias = "dr"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_region" {
    defaults = { name = "il-central-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
}

mock_provider "aws" {
  alias = "dns"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_region" {
    defaults = { name = "il-central-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
}

# A real plan knows the database's security group from state; a mocked one has to be told.
override_module {
  target = module.rds
  outputs = {
    address                = "kesher.cluster-0000.il-central-1.rds.amazonaws.com"
    port                   = 5432
    database_name          = "club"
    security_group_id      = "sg-0000000000000000d"
    instance_arn           = "arn:aws:rds:il-central-1:111111111111:db:kesher"
    instance_identifier    = "kesher"
    master_user_secret_arn = "arn:aws:secretsmanager:il-central-1:111111111111:secret:rds-master-AbCdEf"
    replica_address        = null
  }
}

variables {
  account_id              = "111111111111"
  shared_account_id       = "222222222222"
  hosted_zone_id          = "Z0000000000000000000"
  ecr_registry            = "222222222222.dkr.ecr.il-central-1.amazonaws.com"
  image_tag               = "abc1234"
  locked_backup_vault_arn = "arn:aws:backup:il-central-1:222222222222:backup-vault:kesher-locked"
  temporal_address        = "temporal.kesher.internal:7233"
  temporal_namespace      = "kesher"
  webhook_provider_cidrs  = ["198.51.100.0/24"]
}

run "staging_certificate" {
  command = apply

  module {
    source = "./envs/staging"
  }

  plan_options {
    target = [aws_acm_certificate.this]
  }
}

run "staging_runs_one_service_per_market" {
  command = plan

  module {
    source = "./envs/staging"
  }

  assert {
    condition     = toset(keys(module.api)) == toset(["il", "us"]) && toset(keys(module.jit)) == toset(["il", "us"]) && toset(keys(module.worker)) == toset(["il", "us"])
    error_message = "staging needs one api, jit and worker service for each of IL and US"
  }

  assert {
    condition     = alltrue(flatten([for svc in [module.api, module.jit, module.worker] : [for k, m in svc : m.environment["MARKET"] == upper(k)]]))
    error_message = "each service's MARKET must be its own market"
  }

  assert {
    condition     = toset([for m in values(module.api) : m.image]) == toset(["222222222222.dkr.ecr.il-central-1.amazonaws.com/kesher/api:abc1234"]) && toset([for m in values(module.jit) : m.image]) == toset(["222222222222.dkr.ecr.il-central-1.amazonaws.com/kesher/api:abc1234"]) && toset([for m in values(module.worker) : m.image]) == toset(["222222222222.dkr.ecr.il-central-1.amazonaws.com/kesher/worker:abc1234"])
    error_message = "both markets run the same image and tag"
  }

  assert {
    condition     = module.api["il"].environment["DATABASE_URL"] == module.api["us"].environment["DATABASE_URL"] && module.worker["il"].environment["TOKEN_ISSUER"] == module.worker["us"].environment["TOKEN_ISSUER"]
    error_message = "the markets share one database and one token issuer"
  }

  assert {
    condition     = toset(keys(aws_route53_record.alb)) == toset(["api-il.staging.kesher.example", "api-us.staging.kesher.example", "jit-il.staging.kesher.example", "jit-us.staging.kesher.example", "webhooks-il.staging.kesher.example", "webhooks-us.staging.kesher.example"])
    error_message = "the API, JIT and webhook hosts are per market"
  }

  assert {
    condition     = flatten([for c in aws_lb_listener_rule.webhooks["us"].condition : [for h in c.host_header : tolist(h.values)]]) == ["webhooks-us.staging.kesher.example"] && aws_lb_listener_rule.webhooks["us"].priority != aws_lb_listener_rule.webhooks["il"].priority
    error_message = "the US providers' webhooks land on the US host"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.db_from_services) == 6
    error_message = "every per-market service reaches the one shared database"
  }
}

run "prod_certificate" {
  command = apply

  module {
    source = "./envs/prod"
  }

  plan_options {
    target = [aws_acm_certificate.this]
  }
}

run "prod_runs_one_service_per_market" {
  command = plan

  module {
    source = "./envs/prod"
  }

  assert {
    condition     = toset(keys(module.api)) == toset(["il", "us"]) && toset(keys(module.jit)) == toset(["il", "us"]) && toset(keys(module.worker)) == toset(["il", "us"])
    error_message = "prod needs one api, jit and worker service for each of IL and US"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.db_from_services) == 6
    error_message = "every per-market service reaches the one shared database"
  }
}

# club-prod: the full stack at pilot sizing (Tab 3 §9). Humans do not deploy here; the CI role
# assumes kesher-deploy, and the only interactive path is the break-glass role below.

locals {
  env         = "prod"
  name        = "kesher-${local.env}"
  ci_role_arn = "arn:aws:iam::${var.shared_account_id}:role/kesher-github-ci"
  tags = {
    Project     = "kesher-club"
    Environment = local.env
    ManagedBy   = "terraform"
  }

  hosts = {
    admin   = "admin.${var.domain}"
    app     = "app.${var.domain}"
    console = "console.${var.domain}"
    vpn     = "vpn.${var.domain}"
  }

  # One api, jit and worker service per market (T-0026): the same image with MARKET set, on the shared
  # database, KMS keys and secrets (party ids are unique across markets). `rule` offsets each market's
  # listener rule priorities so they never collide.
  markets = {
    il = { code = "IL", rule = 0 }
    us = { code = "US", rule = 1 }
  }
  market_hosts = {
    for k, _ in local.markets : k => {
      api      = "api-${k}.${var.domain}"
      jit      = "jit-${k}.${var.domain}"
      webhooks = "webhooks-${k}.${var.domain}"
    }
  }
  # The member token issuer names the club, not a host: both markets' APIs mint and accept the same tokens.
  token_issuer = "https://api.${var.domain}"

  database_url = "postgres://club_app@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=verify-full&sslrootcert=/app/db/certs/rds-global-bundle.pem"

  # The authorisation process connects as club_jit (T-0045): it can do what a decision does and nothing more (T-0064).

  jit_database_url = "postgres://club_jit@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=verify-full&sslrootcert=/app/db/certs/rds-global-bundle.pem"

  common_env = {
    NODE_ENV              = "production"
    APP_ENV               = local.env
    PROVIDER_MODE_DEFAULT = "live"
    DATABASE_URL          = local.database_url
    TEMPORAL_ADDRESS      = var.temporal_address
    TEMPORAL_NAMESPACE    = var.temporal_namespace
    AWS_REGION            = var.region
    TOKEN_ISSUER          = local.token_issuer
    JWT_SIGNING_KID       = "kesher-${local.env}-1"
    PORT                  = "3000"
    # Which vendor backs each marketplace and identity port (T-0042). `sim` until an operator opts in with a tfvars value;
    # a named adapter also maps its credential set from Secrets Manager below.
    PROVIDER_ESIM          = var.provider_esim
    PROVIDER_INSURANCE     = var.provider_insurance
    PROVIDER_ORG_IDP       = var.provider_org_idp
    PROVIDER_FEDERATED_IDP = var.provider_federated_idp
    # Stripe backs funding and billing together; each notification channel is chosen on its own (T-0041).
    PROVIDER_FUNDING      = var.provider_funding
    PROVIDER_NOTIFY_SMS   = var.provider_notify_sms
    PROVIDER_NOTIFY_EMAIL = var.provider_notify_email
    PROVIDER_NOTIFY_PUSH  = var.provider_notify_push
  }

  common_secrets = {
    PGPASSWORD           = module.secrets.arns["db-app-password"]
    TEMPORAL_CLIENT_CERT = module.secrets.arns["temporal-client-cert"]
    TEMPORAL_CLIENT_KEY  = module.secrets.arns["temporal-client-key"]
    JWT_SIGNING_KEY      = module.secrets.arns["jwt-signing-key"]
    PII_DATA_KEY         = module.secrets.arns["pii-data-key"]
    PII_INDEX_KEY        = module.secrets.arns["pii-index-key"]
    STAFF_JWKS           = module.secrets.arns["staff-jwks"]
  }
  # Same secrets, but the database password is the club_jit one.
  jit_secrets = merge(local.common_secrets, { PGPASSWORD = module.secrets.arns["db-jit-password"] })

  # Each adapter's whole credential set (T-0042). The process config refuses a partial set, so a set is mapped whole or not at all;
  # an ECS secret with no value would also stop a task from starting, so only the chosen adapter's containers are mapped.
  adapter_secrets = {
    airalo = tomap({
      AIRALO_BASE_URL      = module.secrets.arns["airalo-base-url"]
      AIRALO_CLIENT_ID     = module.secrets.arns["airalo-client-id"]
      AIRALO_CLIENT_SECRET = module.secrets.arns["airalo-client-secret"]
    })
    cover-genius = tomap({
      COVER_GENIUS_BASE_URL              = module.secrets.arns["cover-genius-base-url"]
      COVER_GENIUS_PARTNER_CODE          = module.secrets.arns["cover-genius-partner-code"]
      COVER_GENIUS_API_KEY               = module.secrets.arns["cover-genius-api-key"]
      COVER_GENIUS_API_SECRET            = module.secrets.arns["cover-genius-api-secret"]
      COVER_GENIUS_PRODUCTS              = module.secrets.arns["cover-genius-products"]
      COVER_GENIUS_LICENSED_ENTITY       = module.secrets.arns["cover-genius-licensed-entity"]
      COVER_GENIUS_COMMISSION_DISCLOSURE = module.secrets.arns["cover-genius-commission-disclosure"]
    })
    workos = tomap({
      WORKOS_CLIENT_ID      = module.secrets.arns["workos-client-id"]
      WORKOS_API_KEY        = module.secrets.arns["workos-api-key"]
      WORKOS_WEBHOOK_SECRET = module.secrets.arns["workos-webhook-secret"]
    })
    # Sign in with Apple and Google are offered together or not at all (auth.social.enabled): one set holds both.
    oidc = tomap({
      APPLE_CLIENT_ID      = module.secrets.arns["apple-client-id"]
      APPLE_TEAM_ID        = module.secrets.arns["apple-team-id"]
      APPLE_KEY_ID         = module.secrets.arns["apple-key-id"]
      APPLE_PRIVATE_KEY    = module.secrets.arns["apple-private-key"]
      GOOGLE_CLIENT_ID     = module.secrets.arns["google-client-id"]
      GOOGLE_CLIENT_SECRET = module.secrets.arns["google-client-secret"]
    })
    # T-0041. Stripe's key and endpoint secret are mapped only here: a half-set credential refuses boot, so they are no longer
    # mapped on their own. STRIPE_WEBHOOK_SECRET may hold two comma-separated values during a rotation.
    stripe = tomap({
      STRIPE_API_KEY        = module.secrets.arns["stripe-api-key"]
      STRIPE_WEBHOOK_SECRET = module.secrets.arns["stripe-webhook-secret"]
      STRIPE_PLAN_PRODUCTS  = module.secrets.arns["stripe-plan-products"]
    })
    twilio = tomap({
      TWILIO_ACCOUNT_SID = module.secrets.arns["twilio-account-sid"]
      TWILIO_AUTH_TOKEN  = module.secrets.arns["twilio-auth-token"]
      TWILIO_FROM_SMS    = module.secrets.arns["twilio-from-sms"]
      TWILIO_TEMPLATES   = module.secrets.arns["twilio-templates"]
    })
    postmark = tomap({
      POSTMARK_SERVER_TOKEN = module.secrets.arns["postmark-server-token"]
      POSTMARK_FROM         = module.secrets.arns["postmark-from"]
      POSTMARK_TEMPLATES    = module.secrets.arns["postmark-templates"]
    })
    expo = tomap({
      EXPO_ACCESS_TOKEN = module.secrets.arns["expo-access-token"]
      EXPO_TEMPLATES    = module.secrets.arns["expo-templates"]
    })
  }
  provider_secrets = merge(
    var.provider_esim == "airalo" ? local.adapter_secrets["airalo"] : tomap({}),
    var.provider_insurance == "cover-genius" ? local.adapter_secrets["cover-genius"] : tomap({}),
    var.provider_org_idp == "workos" ? local.adapter_secrets["workos"] : tomap({}),
    var.provider_federated_idp == "oidc" ? local.adapter_secrets["oidc"] : tomap({}),
    var.provider_funding == "stripe" ? local.adapter_secrets["stripe"] : tomap({}),
    var.provider_notify_sms == "twilio" ? local.adapter_secrets["twilio"] : tomap({}),
    var.provider_notify_email == "postmark" ? local.adapter_secrets["postmark"] : tomap({}),
    var.provider_notify_push == "expo" ? local.adapter_secrets["expo"] : tomap({}),
  )

}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  assume_role {
    role_arn     = "arn:aws:iam::${var.account_id}:role/${var.assume_role_name}"
    session_name = "terraform-${local.env}"
  }
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias               = "dr"
  region              = var.dr_region
  allowed_account_ids = [var.account_id]
  assume_role {
    role_arn     = "arn:aws:iam::${var.account_id}:role/${var.assume_role_name}"
    session_name = "terraform-${local.env}-dr"
  }
  default_tags {
    tags = local.tags
  }
}

# Route 53 lives in club-shared; the caller's own credentials (CI role or an operator's
# Identity Center session) write records there.
provider "aws" {
  alias               = "dns"
  region              = var.region
  allowed_account_ids = [var.shared_account_id]
}

data "aws_partition" "current" {}

# ---- account guard rails -----------------------------------------------------------------------

resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---- KMS ---------------------------------------------------------------------------------------

module "kms_rds" {
  source      = "../../modules/kms"
  name        = "${local.name}-rds"
  description = "RDS storage, Performance Insights and the managed master secret"
}

module "kms_secrets" {
  source      = "../../modules/kms"
  name        = "${local.name}-secrets"
  description = "Secrets Manager"
}

module "kms_s3" {
  source      = "../../modules/kms"
  name        = "${local.name}-s3"
  description = "Application S3 buckets"
  # The static web site's bucket is SSE-KMS with this key: CloudFront (Origin Access Control) must be allowed to decrypt it, or every
  # GET is denied (T-0048). Scoped to that one distribution by ARN; no cycle, because the distribution depends on the bucket, not on
  # the bucket's encryption configuration that names this key.
  cloudfront_distribution_arns = [module.web.distribution_arn]
}

module "kms_logs" {
  source             = "../../modules/kms"
  name               = "${local.name}-logs"
  description        = "CloudWatch log groups"
  service_principals = ["logs.${var.region}.amazonaws.com", "delivery.logs.amazonaws.com"]
}

module "kms_backup" {
  source      = "../../modules/kms"
  name        = "${local.name}-backup"
  description = "AWS Backup vault"
}

module "kms_backup_dr" {
  source      = "../../modules/kms"
  name        = "${local.name}-backup-dr"
  description = "AWS Backup vault in the DR region"
  providers = {
    aws = aws.dr
  }
}

# ---- logging bucket, network, certificates -----------------------------------------------------

module "logs_bucket" {
  source = "../../modules/log-bucket"
  name   = "${local.name}-logs-${var.account_id}"
}

resource "aws_iam_saml_provider" "identity_center" {
  count = var.identity_center_saml_metadata == null ? 0 : 1

  name                   = "${local.name}-identity-center"
  saml_metadata_document = var.identity_center_saml_metadata
}

module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.20.0.0/16"
  single_nat_gateway = var.single_nat_gateway
  log_kms_key_arn    = module.kms_logs.key_arn
  client_vpn = var.identity_center_saml_metadata == null ? null : {
    server_certificate_arn = aws_acm_certificate_validation.this.certificate_arn
    saml_provider_arn      = aws_iam_saml_provider.identity_center[0].arn
  }
}

resource "aws_acm_certificate" "this" {
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  provider = aws.dns
  for_each = {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      record = o.resource_record_value
      type   = o.resource_record_type
    }
  }

  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# ---- secrets and database ----------------------------------------------------------------------

module "secrets" {
  source      = "../../modules/secrets"
  prefix      = "kesher/${local.env}"
  kms_key_arn = module.kms_secrets.key_arn
  region      = var.region
  names = [
    "db-app-password",
    "db-jit-password",
    "db-readonly-password",
    "db-migrator-password",
    "jwt-signing-key",
    "temporal-client-cert",
    "temporal-client-key",
    "stripe-api-key",
    "stripe-webhook-secret",
    "stripe-plan-products",
    "twilio-account-sid",
    "twilio-auth-token",
    "twilio-from-sms",
    "twilio-templates",
    "postmark-server-token",
    "postmark-from",
    "postmark-templates",
    "expo-access-token",
    "expo-templates",
    "provider-webhook-secrets",
    "airalo-base-url",
    "airalo-client-id",
    "airalo-client-secret",
    "cover-genius-base-url",
    "cover-genius-partner-code",
    "cover-genius-api-key",
    "cover-genius-api-secret",
    "cover-genius-products",
    "cover-genius-licensed-entity",
    "cover-genius-commission-disclosure",
    "workos-client-id",
    "workos-api-key",
    "workos-webhook-secret",
    "apple-client-id",
    "apple-team-id",
    "apple-key-id",
    "apple-private-key",
    "google-client-id",
    "google-client-secret",
    "pii-data-key",
    "pii-index-key",
    "staff-jwks",
    "admin-api-signing-key",
    "admin-oidc-client-secret",
  ]
}

module "rds" {
  source              = "../../modules/rds"
  name                = local.name
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.database_subnet_ids
  kms_key_arn         = module.kms_rds.key_arn
  instance_class      = var.db_instance_class
  create_read_replica = var.create_read_replica
  deletion_protection = var.deletion_protection
  skip_final_snapshot = !var.deletion_protection
}

# ---- database preparation (T-0044) ---------------------------------------------------------------
# A one-off task inside the VPC: roles, the service roles' passwords and grants, then every schema. Deploys run it before the
# services roll (T-0050); see docs/setup/database.md.
module "migrate" {
  source                = "../../modules/migrate-task"
  name                  = "${local.name}-migrate"
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.private_subnet_ids
  vpc_cidr              = module.network.vpc_cidr
  image                 = "${var.ecr_registry}/kesher/migrate:${var.image_tag}"
  rds_security_group_id = module.rds.security_group_id
  rds_address           = module.rds.address
  rds_port              = module.rds.port
  database_name         = module.rds.database_name
  master_secret_arn     = module.rds.master_user_secret_arn
  secrets = {
    DB_APP_PASSWORD      = module.secrets.arns["db-app-password"]
    DB_JIT_PASSWORD      = module.secrets.arns["db-jit-password"]
    DB_READONLY_PASSWORD = module.secrets.arns["db-readonly-password"]
    DB_MIGRATOR_PASSWORD = module.secrets.arns["db-migrator-password"]
  }
  rds_kms_key_arn     = module.kms_rds.key_arn
  secret_kms_key_arns = [module.kms_secrets.key_arn]
  log_kms_key_arn     = module.kms_logs.key_arn
}

# ---- compute -----------------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

module "alb" {
  source              = "../../modules/alb"
  name                = local.name
  vpc_id              = module.network.vpc_id
  vpc_cidr            = module.network.vpc_cidr
  subnet_ids          = module.network.public_subnet_ids
  certificate_arn     = aws_acm_certificate_validation.this.certificate_arn
  access_logs_bucket  = module.logs_bucket.bucket_name
  log_kms_key_arn     = module.kms_logs.key_arn
  deletion_protection = var.deletion_protection
  webhook_listener    = length(var.webhook_provider_cidrs) == 0 ? null : { allowed_cidrs = var.webhook_provider_cidrs }

  # T-0068: the console's roster import (up to 900 KB) is the one body over 8 KB the WAF lets through; it calls the IL API host (CONSOLE_API_URL).
  large_body_route = { host = local.market_hosts["il"].api, path_regex = "^/v1/institutions/[0-9a-f-]+/rosters$" }
}

module "admin_alb" {
  source              = "../../modules/alb"
  name                = "${local.name}-admin"
  internal            = true
  vpc_id              = module.network.vpc_id
  vpc_cidr            = module.network.vpc_cidr
  subnet_ids          = module.network.private_subnet_ids
  certificate_arn     = aws_acm_certificate_validation.this.certificate_arn
  access_logs_bucket  = module.logs_bucket.bucket_name
  log_kms_key_arn     = module.kms_logs.key_arn
  deletion_protection = var.deletion_protection
}

module "api" {
  source                     = "../../modules/ecs-service"
  for_each                   = local.markets
  name                       = "${local.name}-api-${each.key}"
  cluster_arn                = aws_ecs_cluster.this.arn
  cluster_name               = aws_ecs_cluster.this.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  image                      = "${var.ecr_registry}/kesher/api:${var.image_tag}"
  cpu                        = 1024
  memory                     = 2048
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 8
  environment                = merge(local.common_env, { SERVICE_ROLE = "api", MARKET = each.value.code })
  secrets                    = merge(local.common_secrets, { PROVIDER_WEBHOOK_SECRETS = module.secrets.arns["provider-webhook-secrets"] }, local.provider_secrets)
  secret_kms_key_arns        = [module.kms_secrets.key_arn]
  database_security_group_id = module.rds.security_group_id
  log_kms_key_arn            = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.alb.https_listener_arn
    alb_security_group_id = module.alb.security_group_id
    host_headers          = [local.market_hosts[each.key].api]
    priority              = 10 + each.value.rule
    health_check_path     = "/v1/status"
  }
}

# Provider webhooks arrive on the dedicated listener and land on the api target group.
# Each market's providers post to that market's host, so its own api service verifies and applies them.
resource "aws_lb_listener_rule" "webhooks" {
  for_each = length(var.webhook_provider_cidrs) == 0 ? {} : local.markets

  listener_arn = module.alb.webhook_listener_arn
  priority     = 10 + each.value.rule

  action {
    type             = "forward"
    target_group_arn = module.api[each.key].target_group_arn
  }

  condition {
    host_header {
      values = [local.market_hosts[each.key].webhooks]
    }
  }

  condition {
    path_pattern {
      values = ["/webhooks/*"]
    }
  }
}

module "jit" {
  source        = "../../modules/ecs-service"
  for_each      = local.markets
  name          = "${local.name}-jit-${each.key}"
  cluster_arn   = aws_ecs_cluster.this.arn
  cluster_name  = aws_ecs_cluster.this.name
  vpc_id        = module.network.vpc_id
  subnet_ids    = module.network.private_subnet_ids
  image         = "${var.ecr_registry}/kesher/api:${var.image_tag}"
  cpu           = 1024
  memory        = 2048
  desired_count = 2
  min_capacity  = 2
  max_capacity  = 6
  # The authorisation path never calls a marketplace or identity vendor: it runs those ports on `sim` and is mapped none of their secrets.
  environment                = merge(local.common_env, { SERVICE_ROLE = "jit", MARKET = each.value.code, DATABASE_URL = local.jit_database_url, PROVIDER_ESIM = "sim", PROVIDER_INSURANCE = "sim", PROVIDER_ORG_IDP = "sim", PROVIDER_FEDERATED_IDP = "sim", PROVIDER_FUNDING = "sim", PROVIDER_NOTIFY_SMS = "sim", PROVIDER_NOTIFY_EMAIL = "sim", PROVIDER_NOTIFY_PUSH = "sim" })
  secrets                    = local.jit_secrets
  secret_kms_key_arns        = [module.kms_secrets.key_arn]
  database_security_group_id = module.rds.security_group_id
  log_kms_key_arn            = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.alb.https_listener_arn
    alb_security_group_id = module.alb.security_group_id
    host_headers          = [local.market_hosts[each.key].jit]
    priority              = 20 + each.value.rule
    health_check_path     = "/v1/status" # the API serves no /healthz; the status route is on the jit role (T-0063)
  }
}

module "worker" {
  source                     = "../../modules/ecs-service"
  for_each                   = local.markets
  name                       = "${local.name}-worker-${each.key}"
  cluster_arn                = aws_ecs_cluster.this.arn
  cluster_name               = aws_ecs_cluster.this.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  image                      = "${var.ecr_registry}/kesher/worker:${var.image_tag}"
  cpu                        = 512
  memory                     = 1024
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 6
  environment                = merge(local.common_env, { SERVICE_ROLE = "worker", MARKET = each.value.code })
  secrets                    = merge(local.common_secrets, local.provider_secrets)
  secret_kms_key_arns        = [module.kms_secrets.key_arn]
  database_security_group_id = module.rds.security_group_id
  log_kms_key_arn            = module.kms_logs.key_arn
}

module "admin" {
  source        = "../../modules/ecs-service"
  name          = "${local.name}-admin"
  cluster_arn   = aws_ecs_cluster.this.arn
  cluster_name  = aws_ecs_cluster.this.name
  vpc_id        = module.network.vpc_id
  subnet_ids    = module.network.private_subnet_ids
  image         = "${var.ecr_registry}/kesher/admin:${var.image_tag}"
  cpu           = 512
  memory        = 1024
  desired_count = 1
  min_capacity  = 1
  max_capacity  = 2
  # Everything the console reads in `api` mode (T-0914; apps/admin/src/config.ts): club-wide data from the
  # IL API, bindings from both (T-0913); its IP gate passes only the Client VPN's own subnets.
  environment = {
    NODE_ENV              = "production"
    APP_ENV               = local.env
    ADMIN_ENVIRONMENT     = "production"
    ADMIN_BASE_URL        = "https://${local.hosts.admin}"
    ADMIN_VPN_CIDRS       = join(",", module.network.client_vpn_source_cidrs)
    ADMIN_OIDC_ISSUER     = var.admin_oidc_issuer
    ADMIN_OIDC_AUDIENCE   = var.admin_oidc_client_id
    ADMIN_OIDC_CLIENT_ID  = var.admin_oidc_client_id
    ADMIN_OIDC_JWKS_URL   = var.admin_oidc_jwks_url
    ADMIN_DATA            = "api"
    ADMIN_API_URL_IL      = "https://${local.market_hosts.il.api}/v1"
    ADMIN_API_URL_US      = "https://${local.market_hosts.us.api}/v1"
    ADMIN_API_SIGNING_KID = "kesher-${local.env}-admin-1"
  }
  secrets = {
    ADMIN_API_SIGNING_KEY    = module.secrets.arns["admin-api-signing-key"]
    ADMIN_OIDC_CLIENT_SECRET = module.secrets.arns["admin-oidc-client-secret"]
  }
  secret_kms_key_arns = [module.kms_secrets.key_arn]
  log_kms_key_arn     = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.admin_alb.https_listener_arn
    alb_security_group_id = module.admin_alb.security_group_id
    host_headers          = [local.hosts.admin]
    priority              = 10
    health_check_path     = "/healthz"
  }
}

# The institution console (T-0047): a Next server app, so it runs as a service, not from a bucket. It is
# reached by institution staff, who are not on the VPN, so it sits on the public ALB (and its WAF) at its
# own host. It holds no database credential and no secret: it signs in through the IL API with the staff
# member's own tokens. Its host is the only one on this listener that is not an API host.
module "console" {
  source        = "../../modules/ecs-service"
  name          = "${local.name}-console"
  cluster_arn   = aws_ecs_cluster.this.arn
  cluster_name  = aws_ecs_cluster.this.name
  vpc_id        = module.network.vpc_id
  subnet_ids    = module.network.private_subnet_ids
  image         = "${var.ecr_registry}/kesher/console:${var.image_tag}"
  cpu           = 512
  memory        = 1024
  desired_count = 2
  min_capacity  = 2
  max_capacity  = 4
  environment = {
    NODE_ENV            = "production"
    APP_ENV             = local.env
    CONSOLE_ENVIRONMENT = "production"
    CONSOLE_API_URL     = "https://${local.market_hosts.il.api}/v1"
  }
  log_kms_key_arn = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.alb.https_listener_arn
    alb_security_group_id = module.alb.security_group_id
    host_headers          = [local.hosts.console]
    priority              = 30
    health_check_path     = "/healthz"
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_services" {
  for_each = merge(
    { for k, m in module.api : "api-${k}" => m.security_group_id },
    { for k, m in module.jit : "jit-${k}" => m.security_group_id },
    { for k, m in module.worker : "worker-${k}" => m.security_group_id },
  )

  security_group_id            = module.rds.security_group_id
  description                  = "Postgres from ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# The single-market services became the IL ones (T-0026); state moves instead of a destroy and create.
moved {
  from = module.api
  to   = module.api["il"]
}

moved {
  from = module.jit
  to   = module.jit["il"]
}

moved {
  from = module.worker
  to   = module.worker["il"]
}

moved {
  from = aws_lb_listener_rule.webhooks[0]
  to   = aws_lb_listener_rule.webhooks["il"]
}

moved {
  from = aws_vpc_security_group_ingress_rule.db_from_services["api"]
  to   = aws_vpc_security_group_ingress_rule.db_from_services["api-il"]
}

moved {
  from = aws_vpc_security_group_ingress_rule.db_from_services["jit"]
  to   = aws_vpc_security_group_ingress_rule.db_from_services["jit-il"]
}

moved {
  from = aws_vpc_security_group_ingress_rule.db_from_services["worker"]
  to   = aws_vpc_security_group_ingress_rule.db_from_services["worker-il"]
}

# ---- web apps ----------------------------------------------------------------------------------

module "web" {
  source                            = "../../modules/cloudfront-waf"
  name                              = "${local.name}-web"
  bucket_name                       = "${local.name}-web-${var.account_id}"
  domain_names                      = [local.hosts.app]
  certificate_arn                   = aws_acm_certificate_validation.this.certificate_arn
  kms_key_arn                       = module.kms_s3.key_arn
  s3_access_log_bucket              = module.logs_bucket.bucket_name
  cloudfront_log_bucket_domain_name = module.logs_bucket.bucket_domain_name
}

# ---- DNS ---------------------------------------------------------------------------------------

resource "aws_route53_record" "alb" {
  provider = aws.dns
  for_each = toset(flatten([for h in values(local.market_hosts) : values(h)]))

  zone_id = var.hosted_zone_id
  name    = each.key
  type    = "A"
  alias {
    name                   = module.alb.dns_name
    zone_id                = module.alb.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "admin" {
  provider = aws.dns

  zone_id = var.hosted_zone_id
  name    = local.hosts.admin
  type    = "A"
  alias {
    name                   = module.admin_alb.dns_name
    zone_id                = module.admin_alb.zone_id
    evaluate_target_health = false
  }
}

# The member web app's alias is the only one left on CloudFront. The console's record (which pointed at
# the removed static-site distribution) now points at the public ALB; the keys are unchanged, so it
# updates in place instead of being destroyed and created under the same name.
resource "aws_route53_record" "web_hosts" {
  provider = aws.dns
  for_each = {
    (local.hosts.app) = {
      dns_name               = module.web.distribution_domain_name
      zone_id                = module.web.distribution_hosted_zone_id
      evaluate_target_health = false
    }
    (local.hosts.console) = {
      dns_name               = module.alb.dns_name
      zone_id                = module.alb.zone_id
      evaluate_target_health = true
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.key
  type    = "A"
  alias {
    name                   = each.value.dns_name
    zone_id                = each.value.zone_id
    evaluate_target_health = each.value.evaluate_target_health
  }
}

moved {
  from = aws_route53_record.cloudfront
  to   = aws_route53_record.web_hosts
}

# ---- backups and DR ----------------------------------------------------------------------------

resource "aws_backup_vault" "this" {
  name        = local.name
  kms_key_arn = module.kms_backup.key_arn
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${local.name}-dr"
  kms_key_arn = module.kms_backup_dr.key_arn
}

data "aws_iam_policy_document" "backup_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_trust.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = toset([
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
  ])

  role       = aws_iam_role.backup.name
  policy_arn = each.key
}

resource "aws_backup_plan" "daily" {
  name = "${local.name}-daily"

  rule {
    rule_name         = "daily-0300-utc"
    target_vault_name = aws_backup_vault.this.name
    schedule          = "cron(0 3 * * ? *)"
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = 35
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle {
        delete_after = 35
      }
    }

    copy_action {
      destination_vault_arn = var.locked_backup_vault_arn
      lifecycle {
        delete_after = 35
      }
    }
  }
}

resource "aws_backup_selection" "rds" {
  name         = "${local.name}-rds"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [module.rds.instance_arn]
}

# ---- alarms, paging, dashboards and budget (T-0054) --------------------------------------------------------------------
# One alarm per row of the runbook alert table, each naming its RUN (modules/alarms). The pager endpoint has no default: an apply
# says where pages go. A hand apply passes it (-var pager_endpoint=... or TF_VAR_pager_endpoint); the deploy workflow (T-0050) passes the
# GitHub environment secret PAGER_ENDPOINT as TF_VAR_pager_endpoint and refuses to start without it.

variable "pager_endpoint" {
  description = "HTTPS endpoint of the pager integration (PagerDuty or Opsgenie); no default, pages must go somewhere."
  type        = string
  sensitive   = true
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget; notices at 50, 80 and 100 percent of actual spend go to the tickets topic."
  type        = number
  default     = 10000
}

# RDS max_connections is LEAST(DBInstanceClassMemory / 9531392, 5000); the alarm is at 80% of it. Memory is the class's nominal GiB
# (the real DBInstanceClassMemory is a little lower, so the margin is a little smaller). db.t4g.large 8 GiB: 901, alarm at 720.
# db.r7g.large 16 GiB: 1802, alarm at 1441. An unlisted class assumes 4 GiB, so it alarms early rather than late.
locals {
  db_memory_gib = {
    "db.t4g.large" = 8
    "db.r7g.large" = 16
  }
}

module "alarms" {
  source                 = "../../modules/alarms"
  name                   = local.name
  pager_endpoint         = var.pager_endpoint
  budget_limit_usd       = var.monthly_budget_usd
  db_instance_identifier = module.rds.instance_identifier
  db_replica_identifier  = var.create_read_replica ? "${local.name}-replica" : null
  db_max_connections     = floor(0.8 * min(5000, lookup(local.db_memory_gib, var.db_instance_class, 4) * 1073741824 / 9531392))
  certificate_arns       = { platform = aws_acm_certificate_validation.this.certificate_arn }
  tags                   = local.tags

  ingress_services = merge(
    { for k, m in module.api : "api-${k}" => { load_balancer_arn = module.alb.arn, target_group_arn = m.target_group_arn, run = "RUN-05" } },
    { for k, m in module.jit : "jit-${k}" => { load_balancer_arn = module.alb.arn, target_group_arn = m.target_group_arn, run = "RUN-02" } },
    { admin = { load_balancer_arn = module.admin_alb.arn, target_group_arn = module.admin.target_group_arn, run = "RUN-05" } },
    { console = { load_balancer_arn = module.alb.arn, target_group_arn = module.console.target_group_arn, run = "RUN-05" } },
  )

  ecs_services = merge(
    { for k, m in module.api : "api-${k}" => { cluster_name = aws_ecs_cluster.this.name, service_name = m.service_name, run = "RUN-05" } },
    { for k, m in module.jit : "jit-${k}" => { cluster_name = aws_ecs_cluster.this.name, service_name = m.service_name, run = "RUN-02" } },
    { for k, m in module.worker : "worker-${k}" => { cluster_name = aws_ecs_cluster.this.name, service_name = m.service_name, run = "RUN-05" } },
    { admin = { cluster_name = aws_ecs_cluster.this.name, service_name = module.admin.service_name, run = "RUN-05" } },
    { console = { cluster_name = aws_ecs_cluster.this.name, service_name = module.console.service_name, run = "RUN-05" } },
  )
}

# ---- deploy role (assumed by the CI role in club-shared) ---------------------------------------

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "AWS"
      identifiers = [local.ci_role_arn]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "kesher-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "deploy_power_user" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/PowerUserAccess"
}

# PowerUserAccess excludes IAM; the deploy role may manage only the platform's own kesher-* roles
# and policies, and pass them to the services that use them.
data "aws_iam_policy_document" "deploy_iam" {
  statement {
    sid = "ManageKesherRoles"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PassRole",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${var.account_id}:role/kesher-*"]
  }

  statement {
    sid       = "ManageSamlProvider"
    actions   = ["iam:CreateSAMLProvider", "iam:UpdateSAMLProvider", "iam:DeleteSAMLProvider", "iam:GetSAMLProvider"]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${var.account_id}:saml-provider/kesher-*"]
  }

  statement {
    sid       = "ServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${var.account_id}:role/aws-service-role/*"]
  }
}

resource "aws_iam_role_policy" "deploy_iam" {
  name   = "kesher-iam-scope"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_iam.json
}

# ---- break-glass -------------------------------------------------------------------------------

data "aws_iam_policy_document" "break_glass_trust" {
  count = length(var.break_glass_principal_arns) == 0 ? 0 : 1

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = var.break_glass_principal_arns
    }
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
  }
}

# One-hour sessions, every call lands in the org CloudTrail; use is an incident by definition.
resource "aws_iam_role" "break_glass" {
  count = length(var.break_glass_principal_arns) == 0 ? 0 : 1

  name                 = "kesher-break-glass"
  assume_role_policy   = data.aws_iam_policy_document.break_glass_trust[0].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "break_glass" {
  count = length(var.break_glass_principal_arns) == 0 ? 0 : 1

  role       = aws_iam_role.break_glass[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AdministratorAccess"
}

# ---- services the deploy waits on (T-0050) -----------------------------------------------------------------------------
# .github/workflows/deploy.yml waits for each of these ECS services to be stable after the apply rolls them, then checks that
# each one runs the tag it deployed (a service the circuit breaker rolled back is "stable" too).
output "ecs_service_names" {
  description = "Every ECS service of the environment, keyed api-<market>, jit-<market>, worker-<market>, admin and console."
  value = merge(
    { for k, m in module.api : "api-${k}" => m.service_name },
    { for k, m in module.jit : "jit-${k}" => m.service_name },
    { for k, m in module.worker : "worker-${k}" => m.service_name },
    { admin = module.admin.service_name, console = module.console.service_name },
  )
}

# ---- static web site (T-0048) -------------------------------------------------------------------------------------------
# .github/workflows/deploy-web.yml syncs apps/web's `out/` to this bucket and invalidates this distribution. Set them as the
# variables WEB_BUCKET and WEB_DISTRIBUTION_ID on the GitHub environment (apps/web/README.md).
output "web_bucket_name" {
  description = "The bucket behind app.<domain> that the web deploy workflow publishes the static site to."
  value       = module.web.bucket_name
}

output "web_distribution_id" {
  description = "The CloudFront distribution of app.<domain>, invalidated after each web deploy."
  value       = module.web.distribution_id
}

# ---- marketplace and identity providers (T-0042) -------------------------------------------------
# `sim` binds the simulator; a named adapter needs its credential containers filled first (docs/setup/secrets.md), or the
# process refuses to boot naming the missing keys.
variable "provider_esim" {
  description = "Which provider backs eSIM: sim or airalo."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "airalo"], var.provider_esim)
    error_message = "provider_esim must be sim or airalo."
  }
}

variable "provider_insurance" {
  description = "Which provider backs insurance: sim or cover-genius."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "cover-genius"], var.provider_insurance)
    error_message = "provider_insurance must be sim or cover-genius."
  }
}

variable "provider_org_idp" {
  description = "Which provider backs institution SSO: sim or workos."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "workos"], var.provider_org_idp)
    error_message = "provider_org_idp must be sim or workos."
  }
}

variable "provider_federated_idp" {
  description = "Which provider backs Sign in with Apple and Google (both or neither): sim or oidc."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "oidc"], var.provider_federated_idp)
    error_message = "provider_federated_idp must be sim or oidc."
  }
}

# ---- Stripe and notification channels (T-0041) ---------------------------------------------------
# Same rule as above: `sim` until an operator opts in, and the named adapter's containers are filled first. Only sandbox
# credentials are accepted (the config refuses a live Stripe key until the production guard, T-0043).
variable "provider_funding" {
  description = "Which provider backs funding and billing together: sim or stripe."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "stripe"], var.provider_funding)
    error_message = "provider_funding must be sim or stripe."
  }
}

variable "provider_notify_sms" {
  description = "Which provider sends SMS: sim or twilio."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "twilio"], var.provider_notify_sms)
    error_message = "provider_notify_sms must be sim or twilio."
  }
}

variable "provider_notify_email" {
  description = "Which provider sends email: sim or postmark."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "postmark"], var.provider_notify_email)
    error_message = "provider_notify_email must be sim or postmark."
  }
}

variable "provider_notify_push" {
  description = "Which provider sends push notifications: sim or expo."
  type        = string
  default     = "sim"
  validation {
    condition     = contains(["sim", "expo"], var.provider_notify_push)
    error_message = "provider_notify_push must be sim or expo."
  }
}

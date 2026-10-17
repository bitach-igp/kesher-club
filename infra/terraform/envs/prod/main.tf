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
    api      = "api.${var.domain}"
    jit      = "jit.${var.domain}"
    webhooks = "webhooks.${var.domain}"
    admin    = "admin.${var.domain}"
    app      = "app.${var.domain}"
    console  = "console.${var.domain}"
    vpn      = "vpn.${var.domain}"
  }

  database_url = "postgres://club_app@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=require"

  common_env = {
    NODE_ENV              = "production"
    APP_ENV               = local.env
    PROVIDER_MODE_DEFAULT = "live"
    DATABASE_URL          = local.database_url
    TEMPORAL_ADDRESS      = var.temporal_address
    TEMPORAL_NAMESPACE    = var.temporal_namespace
    AWS_REGION            = var.region
  }

  common_secrets = {
    PGPASSWORD           = module.secrets.arns["db-app-password"]
    TEMPORAL_CLIENT_CERT = module.secrets.arns["temporal-client-cert"]
    TEMPORAL_CLIENT_KEY  = module.secrets.arns["temporal-client-key"]
    JWT_SIGNING_KEY      = module.secrets.arns["jwt-signing-key"]
  }
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
    "jwt-signing-key",
    "temporal-client-cert",
    "temporal-client-key",
    "stripe-api-key",
    "stripe-webhook-secret",
    "provider-webhook-secrets",
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
  name                       = "${local.name}-api"
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
  environment                = merge(local.common_env, { SERVICE_ROLE = "api" })
  secrets                    = merge(local.common_secrets, { STRIPE_API_KEY = module.secrets.arns["stripe-api-key"], STRIPE_WEBHOOK_SECRET = module.secrets.arns["stripe-webhook-secret"], PROVIDER_WEBHOOK_SECRETS = module.secrets.arns["provider-webhook-secrets"] })
  secret_kms_key_arns        = [module.kms_secrets.key_arn]
  database_security_group_id = module.rds.security_group_id
  log_kms_key_arn            = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.alb.https_listener_arn
    alb_security_group_id = module.alb.security_group_id
    host_headers          = [local.hosts.api]
    priority              = 10
  }
}

# Provider webhooks arrive on the dedicated listener and land on the api target group.
resource "aws_lb_listener_rule" "webhooks" {
  count = length(var.webhook_provider_cidrs) == 0 ? 0 : 1

  listener_arn = module.alb.webhook_listener_arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = module.api.target_group_arn
  }

  condition {
    host_header {
      values = [local.hosts.webhooks]
    }
  }

  condition {
    path_pattern {
      values = ["/webhooks/*"]
    }
  }
}

module "jit" {
  source                     = "../../modules/ecs-service"
  name                       = "${local.name}-jit"
  cluster_arn                = aws_ecs_cluster.this.arn
  cluster_name               = aws_ecs_cluster.this.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  image                      = "${var.ecr_registry}/kesher/api:${var.image_tag}"
  cpu                        = 1024
  memory                     = 2048
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 6
  environment                = merge(local.common_env, { SERVICE_ROLE = "jit" })
  secrets                    = local.common_secrets
  secret_kms_key_arns        = [module.kms_secrets.key_arn]
  database_security_group_id = module.rds.security_group_id
  log_kms_key_arn            = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.alb.https_listener_arn
    alb_security_group_id = module.alb.security_group_id
    host_headers          = [local.hosts.jit]
    priority              = 20
  }
}

module "worker" {
  source                     = "../../modules/ecs-service"
  name                       = "${local.name}-worker"
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
  environment                = merge(local.common_env, { SERVICE_ROLE = "worker" })
  secrets                    = merge(local.common_secrets, { STRIPE_API_KEY = module.secrets.arns["stripe-api-key"] })
  secret_kms_key_arns        = [module.kms_secrets.key_arn]
  database_security_group_id = module.rds.security_group_id
  log_kms_key_arn            = module.kms_logs.key_arn
}

module "admin" {
  source          = "../../modules/ecs-service"
  name            = "${local.name}-admin"
  cluster_arn     = aws_ecs_cluster.this.arn
  cluster_name    = aws_ecs_cluster.this.name
  vpc_id          = module.network.vpc_id
  subnet_ids      = module.network.private_subnet_ids
  image           = "${var.ecr_registry}/kesher/admin:${var.image_tag}"
  cpu             = 512
  memory          = 1024
  desired_count   = 1
  min_capacity    = 1
  max_capacity    = 2
  environment     = { NODE_ENV = "production", APP_ENV = local.env, API_BASE_URL = "https://${local.hosts.api}" }
  log_kms_key_arn = module.kms_logs.key_arn
  ingress = {
    listener_arn          = module.admin_alb.https_listener_arn
    alb_security_group_id = module.admin_alb.security_group_id
    host_headers          = [local.hosts.admin]
    priority              = 10
    health_check_path     = "/api/healthz"
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_services" {
  for_each = {
    api    = module.api.security_group_id
    jit    = module.jit.security_group_id
    worker = module.worker.security_group_id
  }

  security_group_id            = module.rds.security_group_id
  description                  = "Postgres from ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
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

module "console" {
  source                            = "../../modules/cloudfront-waf"
  name                              = "${local.name}-console"
  bucket_name                       = "${local.name}-console-${var.account_id}"
  domain_names                      = [local.hosts.console]
  certificate_arn                   = aws_acm_certificate_validation.this.certificate_arn
  kms_key_arn                       = module.kms_s3.key_arn
  s3_access_log_bucket              = module.logs_bucket.bucket_name
  cloudfront_log_bucket_domain_name = module.logs_bucket.bucket_domain_name
}

# ---- DNS ---------------------------------------------------------------------------------------

resource "aws_route53_record" "alb" {
  provider = aws.dns
  for_each = toset([local.hosts.api, local.hosts.jit, local.hosts.webhooks])

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

resource "aws_route53_record" "cloudfront" {
  provider = aws.dns
  for_each = {
    (local.hosts.app)     = module.web
    (local.hosts.console) = module.console
  }

  zone_id = var.hosted_zone_id
  name    = each.key
  type    = "A"
  alias {
    name                   = each.value.distribution_domain_name
    zone_id                = each.value.distribution_hosted_zone_id
    evaluate_target_health = false
  }
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

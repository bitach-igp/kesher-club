# Per-PR preview on the staging cluster: one api task and one worker task on this PR's image,
# every provider bound to its simulator (PROVIDER_MODE_DEFAULT=sim), a dedicated Postgres
# database on the shared staging RDS instance and the hostname preview-<pr>.<staging domain>.
# Everything about staging is read from the SSM parameters infra/terraform/envs/staging exports.

locals {
  name = "kesher-preview-${var.pr_number}"
  # Plain String parameters (no secrets): insecure_value keeps them out of the sensitive taint
  # that would otherwise block their use in for_each keys and counts.
  cfg        = { for k, p in data.aws_ssm_parameter.staging : k => p.insecure_value }
  hostname   = "preview-${var.pr_number}.${local.cfg.domain}"
  url        = "https://${local.hostname}"
  db_name    = "preview_${var.pr_number}"
  deploy_arn = "arn:aws:iam::${var.staging_account_id}:role/${var.assume_role_name}"

  tags = {
    Project     = "kesher-club"
    Environment = "preview"
    PullRequest = tostring(var.pr_number)
    ManagedBy   = "terraform"
  }

  # The password is not part of the URL: node-postgres (and libpq) read PGPASSWORD, which the
  # ECS secrets integration injects straight from Secrets Manager.
  database_url = "postgres://club_app@${local.cfg.rds_address}:${local.cfg.rds_port}/${local.db_name}?sslmode=require"

  common_env = {
    NODE_ENV                   = "production"
    APP_ENV                    = "preview"
    PREVIEW_PR                 = tostring(var.pr_number)
    PUBLIC_URL                 = local.url
    PROVIDER_MODE_DEFAULT      = "sim"
    DATABASE_URL               = local.database_url
    MIGRATE_ON_BOOT            = "true"
    TEMPORAL_ADDRESS           = local.cfg.temporal_address
    TEMPORAL_NAMESPACE         = local.cfg.temporal_namespace
    TEMPORAL_TASK_QUEUE_PREFIX = "preview-${var.pr_number}"
    AWS_REGION                 = var.region
  }

  common_secrets = {
    PGPASSWORD           = local.cfg.db_app_password_secret_arn
    JWT_SIGNING_KEY      = local.cfg.jwt_signing_key_secret_arn
    TEMPORAL_CLIENT_CERT = local.cfg.temporal_cert_secret_arn
    TEMPORAL_CLIENT_KEY  = local.cfg.temporal_key_secret_arn
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.staging_account_id]
  assume_role {
    role_arn     = local.deploy_arn
    session_name = "terraform-preview-${var.pr_number}"
  }
  default_tags {
    tags = local.tags
  }
}

# Route 53 lives in club-shared and is written with the caller's own (CI role) credentials.
provider "aws" {
  alias               = "dns"
  region              = var.region
  allowed_account_ids = [var.shared_account_id]
}

data "aws_ssm_parameter" "staging" {
  for_each = toset([
    "cluster_arn", "cluster_name", "vpc_id", "private_subnet_ids",
    "https_listener_arn", "alb_security_group_id", "alb_dns_name", "alb_zone_id",
    "rds_security_group_id", "rds_address", "rds_port",
    "log_kms_key_arn", "secrets_kms_key_arn",
    "db_app_password_secret_arn", "jwt_signing_key_secret_arn", "temporal_cert_secret_arn", "temporal_key_secret_arn",
    "temporal_address", "temporal_namespace",
    "db_tool_task_definition", "db_tool_security_group_id",
    "ecr_registry", "hosted_zone_id", "domain",
  ])

  name = "/kesher/staging/preview/${each.key}"
}

# ---- database ----------------------------------------------------------------------------------

# CREATE DATABASE / DROP DATABASE run as a one-off Fargate task inside the VPC (see README for
# why not the postgresql provider). Every value the destroy-time provisioner needs is a trigger.
resource "null_resource" "database" {
  triggers = {
    db_name         = local.db_name
    cluster         = local.cfg.cluster_arn
    task_definition = local.cfg.db_tool_task_definition
    subnets         = local.cfg.private_subnet_ids
    security_group  = local.cfg.db_tool_security_group_id
    region          = var.region
    role_arn        = local.deploy_arn
    script          = filesha256("${path.module}/scripts/preview-db.sh")
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/preview-db.sh create"
    environment = {
      PREVIEW_DB_NAME        = self.triggers.db_name
      PREVIEW_CLUSTER        = self.triggers.cluster
      PREVIEW_TASK_DEF       = self.triggers.task_definition
      PREVIEW_SUBNETS        = self.triggers.subnets
      PREVIEW_SECURITY_GROUP = self.triggers.security_group
      PREVIEW_REGION         = self.triggers.region
      PREVIEW_ROLE_ARN       = self.triggers.role_arn
    }
  }

  provisioner "local-exec" {
    when    = destroy
    command = "${path.module}/scripts/preview-db.sh drop"
    environment = {
      PREVIEW_DB_NAME        = self.triggers.db_name
      PREVIEW_CLUSTER        = self.triggers.cluster
      PREVIEW_TASK_DEF       = self.triggers.task_definition
      PREVIEW_SUBNETS        = self.triggers.subnets
      PREVIEW_SECURITY_GROUP = self.triggers.security_group
      PREVIEW_REGION         = self.triggers.region
      PREVIEW_ROLE_ARN       = self.triggers.role_arn
    }
  }
}

# ---- services ----------------------------------------------------------------------------------

module "api" {
  source = "../terraform/modules/ecs-service"

  name                       = "${local.name}-api"
  cluster_arn                = local.cfg.cluster_arn
  cluster_name               = local.cfg.cluster_name
  vpc_id                     = local.cfg.vpc_id
  subnet_ids                 = split(",", local.cfg.private_subnet_ids)
  image                      = "${local.cfg.ecr_registry}/kesher/api:${var.image_tag}"
  cpu                        = 512
  memory                     = 1024
  desired_count              = 1
  min_capacity               = 1
  max_capacity               = 2
  environment                = merge(local.common_env, { SERVICE_ROLE = "api" })
  secrets                    = local.common_secrets
  secret_kms_key_arns        = [local.cfg.secrets_kms_key_arn]
  database_security_group_id = local.cfg.rds_security_group_id
  log_kms_key_arn            = local.cfg.log_kms_key_arn
  log_retention_days         = 7
  tags                       = local.tags

  ingress = {
    listener_arn          = local.cfg.https_listener_arn
    alb_security_group_id = local.cfg.alb_security_group_id
    host_headers          = [local.hostname]
    priority              = 1000 + var.pr_number
  }

  depends_on = [null_resource.database]
}

module "worker" {
  source = "../terraform/modules/ecs-service"

  name                       = "${local.name}-worker"
  cluster_arn                = local.cfg.cluster_arn
  cluster_name               = local.cfg.cluster_name
  vpc_id                     = local.cfg.vpc_id
  subnet_ids                 = split(",", local.cfg.private_subnet_ids)
  image                      = "${local.cfg.ecr_registry}/kesher/worker:${var.image_tag}"
  cpu                        = 256
  memory                     = 512
  desired_count              = 1
  min_capacity               = 1
  max_capacity               = 1
  environment                = merge(local.common_env, { SERVICE_ROLE = "worker" })
  secrets                    = local.common_secrets
  secret_kms_key_arns        = [local.cfg.secrets_kms_key_arn]
  database_security_group_id = local.cfg.rds_security_group_id
  log_kms_key_arn            = local.cfg.log_kms_key_arn
  log_retention_days         = 7
  tags                       = local.tags

  depends_on = [null_resource.database]
}

resource "aws_vpc_security_group_ingress_rule" "db_from_preview" {
  for_each = {
    api    = module.api.security_group_id
    worker = module.worker.security_group_id
  }

  security_group_id            = local.cfg.rds_security_group_id
  description                  = "Postgres from ${local.name}-${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ---- DNS ---------------------------------------------------------------------------------------

resource "aws_route53_record" "preview" {
  provider = aws.dns

  zone_id = local.cfg.hosted_zone_id
  name    = local.hostname
  type    = "A"
  alias {
    name                   = local.cfg.alb_dns_name
    zone_id                = local.cfg.alb_zone_id
    evaluate_target_health = false
  }
}

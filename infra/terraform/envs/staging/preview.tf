# Support for per-PR preview environments (infra/preview, T-0010).
#
# 1. A "db-tool" Fargate task definition (psql in the official Postgres image) that infra/preview
#    runs with `aws ecs run-task` to CREATE / DROP a per-PR database on this RDS instance. It
#    runs inside the VPC with the RDS-managed master secret, so neither GitHub runners nor
#    Terraform ever see a database password.
# 2. SSM parameters that export everything the preview root needs, so previews never read this
#    root's state file.

resource "aws_cloudwatch_log_group" "db_tool" {
  name              = "/kesher/${local.name}-db-tool"
  retention_in_days = 30
  kms_key_id        = module.kms_logs.key_arn
}

resource "aws_security_group" "db_tool" {
  name        = "${local.name}-db-tool"
  description = "One-off psql tasks for preview databases"
  vpc_id      = module.network.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "db_tool_postgres" {
  security_group_id            = aws_security_group.db_tool.id
  description                  = "Postgres"
  referenced_security_group_id = module.rds.security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# Image pulls and log delivery go through the ECR/Logs interface endpoints.
resource "aws_vpc_security_group_egress_rule" "db_tool_https" {
  security_group_id = aws_security_group.db_tool.id
  description       = "HTTPS to VPC endpoints"
  cidr_ipv4         = module.network.vpc_cidr
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_db_tool" {
  security_group_id            = module.rds.security_group_id
  description                  = "Postgres from the preview db-tool"
  referenced_security_group_id = aws_security_group.db_tool.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "db_tool_execution" {
  name               = "${local.name}-db-tool-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "db_tool_execution" {
  role       = aws_iam_role.db_tool_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "db_tool_execution" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.rds.master_user_secret_arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [module.kms_rds.key_arn, module.kms_logs.key_arn]
  }
}

resource "aws_iam_role_policy" "db_tool_execution" {
  name   = "master-secret"
  role   = aws_iam_role.db_tool_execution.id
  policy = data.aws_iam_policy_document.db_tool_execution.json
}

resource "aws_ecs_task_definition" "db_tool" {
  family                   = "${local.name}-db-tool"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.db_tool_execution.arn

  container_definitions = jsonencode([
    {
      name      = "psql"
      image     = "public.ecr.aws/docker/library/postgres:16-alpine"
      essential = true
      command   = ["psql", "--version"] # overridden per run by infra/preview/scripts/preview-db.sh
      environment = [
        { name = "PGHOST", value = module.rds.address },
        { name = "PGPORT", value = tostring(module.rds.port) },
        { name = "PGDATABASE", value = "postgres" },
        { name = "PGSSLMODE", value = "require" },
      ]
      secrets = [
        { name = "PGUSER", valueFrom = "${module.rds.master_user_secret_arn}:username::" },
        { name = "PGPASSWORD", valueFrom = "${module.rds.master_user_secret_arn}:password::" },
      ]
      readonlyRootFilesystem = true
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.db_tool.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "run"
        }
      }
    }
  ])
}

locals {
  preview_exports = {
    cluster_arn                = aws_ecs_cluster.this.arn
    cluster_name               = aws_ecs_cluster.this.name
    vpc_id                     = module.network.vpc_id
    private_subnet_ids         = join(",", module.network.private_subnet_ids)
    https_listener_arn         = module.alb.https_listener_arn
    alb_security_group_id      = module.alb.security_group_id
    alb_dns_name               = module.alb.dns_name
    alb_zone_id                = module.alb.zone_id
    rds_security_group_id      = module.rds.security_group_id
    rds_address                = module.rds.address
    rds_port                   = tostring(module.rds.port)
    log_kms_key_arn            = module.kms_logs.key_arn
    secrets_kms_key_arn        = module.kms_secrets.key_arn
    db_app_password_secret_arn = module.secrets.arns["db-app-password"]
    jwt_signing_key_secret_arn = module.secrets.arns["jwt-signing-key"]
    temporal_cert_secret_arn   = module.secrets.arns["temporal-client-cert"]
    temporal_key_secret_arn    = module.secrets.arns["temporal-client-key"]
    temporal_address           = var.temporal_address
    temporal_namespace         = var.temporal_namespace
    db_tool_task_definition    = aws_ecs_task_definition.db_tool.family
    db_tool_security_group_id  = aws_security_group.db_tool.id
    ecr_registry               = var.ecr_registry
    hosted_zone_id             = var.hosted_zone_id
    domain                     = var.domain
  }
}

resource "aws_ssm_parameter" "preview" {
  for_each = local.preview_exports

  name  = "/kesher/staging/preview/${each.key}"
  type  = "String"
  value = each.value
  tier  = "Standard"
}

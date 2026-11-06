# The one-off Fargate task that prepares a deployed database (T-0044, db/prepare.mjs). The RDS instance is in isolated subnets, so
# nothing outside the VPC can reach it: deploys run this task (`aws ecs run-task`, T-0050) before the services roll. It connects
# with the RDS-managed master secret to create roles and with club_migrator to apply the schemas; every password comes from
# Secrets Manager into the container's environment, and no credential reaches a runner, the Terraform state or a log line.

data "aws_partition" "current" {}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/kesher/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

resource "aws_security_group" "this" {
  name        = var.name
  description = "Database preparation task: Postgres out, HTTPS to the VPC endpoints, nothing in"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_egress_rule" "postgres" {
  security_group_id            = aws_security_group.this.id
  description                  = "Postgres"
  referenced_security_group_id = var.rds_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS to the VPC endpoints"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_task" {
  security_group_id            = var.rds_security_group_id
  description                  = "Postgres from the database preparation task"
  referenced_security_group_id = aws_security_group.this.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role only: the container itself has no AWS permissions (the task role is left unset). The role reads exactly the
# secrets the task is given.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([var.master_secret_arn], values(var.secrets))
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = concat([var.rds_kms_key_arn, var.log_kms_key_arn], var.secret_kms_key_arns)
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  tags                     = var.tags

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = var.image
      essential = true
      environment = [
        { name = "PGHOST", value = var.rds_address },
        { name = "PGPORT", value = tostring(var.rds_port) },
        { name = "PGDATABASE", value = var.database_name },
        { name = "PGSSLMODE", value = "verify-full" },
        { name = "PGSSLROOTCERT", value = "/app/db/certs/rds-global-bundle.pem" },
      ]
      secrets = concat(
        [
          { name = "PGUSER", valueFrom = "${var.master_secret_arn}:username::" },
          { name = "PGPASSWORD", valueFrom = "${var.master_secret_arn}:password::" },
        ],
        [for k in sort(keys(var.secrets)) : { name = k, valueFrom = var.secrets[k] }],
      )
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "run"
        }
      }
    }
  ])
}

data "aws_region" "current" {}

# Plan-mode checks for modules/migrate-task (T-0044): private, read-only, every credential from Secrets Manager.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name                  = "kesher-test-migrate"
  vpc_id                = "vpc-00000000000000000"
  subnet_ids            = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
  vpc_cidr              = "10.10.0.0/16"
  image                 = "111111111111.dkr.ecr.us-east-1.amazonaws.com/kesher/migrate:test"
  rds_security_group_id = "sg-0000000000000000a"
  rds_address           = "db.test.internal"
  rds_port              = 5432
  database_name         = "club"
  master_secret_arn     = "arn:aws:secretsmanager:us-east-1:111111111111:secret:rds!db-master-AbCdEf"
  secrets = {
    DB_APP_PASSWORD      = "arn:aws:secretsmanager:us-east-1:111111111111:secret:kesher/test/db-app-password-AbCdEf"
    DB_JIT_PASSWORD      = "arn:aws:secretsmanager:us-east-1:111111111111:secret:kesher/test/db-jit-password-AbCdEf"
    DB_READONLY_PASSWORD = "arn:aws:secretsmanager:us-east-1:111111111111:secret:kesher/test/db-readonly-password-AbCdEf"
    DB_MIGRATOR_PASSWORD = "arn:aws:secretsmanager:us-east-1:111111111111:secret:kesher/test/db-migrator-password-AbCdEf"
  }
  rds_kms_key_arn     = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000001"
  secret_kms_key_arns = ["arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000002"]
  log_kms_key_arn     = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000003"
}

run "migrate_task" {
  command = plan

  module {
    source = "./modules/migrate-task"
  }

  assert {
    condition     = aws_ecs_task_definition.this.network_mode == "awsvpc" && contains(aws_ecs_task_definition.this.requires_compatibilities, "FARGATE")
    error_message = "a Fargate task in awsvpc mode, run in the private subnets by the caller"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].readonlyRootFilesystem == true
    error_message = "the root filesystem is read-only; /tmp is a volume"
  }

  assert {
    condition     = length([for s in jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets : s if startswith(s.valueFrom, "arn:aws:secretsmanager:")]) == 6
    error_message = "the master user and password plus the four service-role passwords come from Secrets Manager"
  }

  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment : e if length(regexall("(?i)password|secret|token", e.name)) > 0]) == 0
    error_message = "no secret-looking name is a plain environment value"
  }

  assert {
    condition     = toset([for s in jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets : s.name]) == toset(["PGUSER", "PGPASSWORD", "DB_APP_PASSWORD", "DB_JIT_PASSWORD", "DB_READONLY_PASSWORD", "DB_MIGRATOR_PASSWORD"])
    error_message = "the names db/prepare.mjs requires, and nothing else"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.postgres.from_port == 5432 && aws_vpc_security_group_egress_rule.https.cidr_ipv4 == "10.10.0.0/16"
    error_message = "egress is Postgres to the database and HTTPS inside the VPC only"
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.kms_key_id == var.log_kms_key_arn
    error_message = "the log group is CMK-encrypted"
  }

  assert {
    condition     = output.network_configuration.assign_public_ip == false && output.network_configuration.subnets == var.subnet_ids
    error_message = "the task is run in the private subnets with no public IP"
  }

  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.secrets.statement : s.resources if contains(s.actions, "secretsmanager:GetSecretValue")])) == toset(concat([var.master_secret_arn], values(var.secrets)))
    error_message = "the execution role reads exactly the master secret and the four passwords"
  }
}

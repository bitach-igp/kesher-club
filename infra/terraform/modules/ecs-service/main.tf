# One ECS Fargate service: task definition, IAM roles, KMS-encrypted log group, security group,
# CPU target-tracking autoscaling and (optionally) an ALB target group + host/path listener rule.
# Tasks run in private subnets without public IPs. Secrets reach the container only through the
# ECS secrets integration (Secrets Manager ARN -> env var), never as plain environment values.

data "aws_region" "current" {}

locals {
  secret_arns = distinct([for arn in values(var.secrets) : regex("^(arn:[^:]+:secretsmanager:[^:]+:[^:]+:secret:[^:]+)", arn)[0]])
  ingress_on  = var.ingress != null
}

# ---- logging -----------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = "/kesher/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

# ---- IAM ---------------------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  dynamic "statement" {
    for_each = length(local.secret_arns) > 0 ? [1] : []
    content {
      sid       = "InjectSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }

  statement {
    sid       = "DecryptSecretsAndLogs"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = distinct(compact(concat([var.log_kms_key_arn], var.secret_kms_key_arns)))
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "secrets-and-logs"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "task" {
  count = var.task_policy_json == null ? 0 : 1

  name   = "application"
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

# ---- network -----------------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = var.name
  description = "${var.name} tasks"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = var.name })
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  count = local.ingress_on ? 1 : 0

  security_group_id            = aws_security_group.this.id
  description                  = "Container port from the load balancer"
  referenced_security_group_id = var.ingress.alb_security_group_id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

# Outbound HTTPS leaves through NAT to Temporal Cloud and vendor APIs; AWS services use the VPC
# endpoints. Only port 443 is open, so the wildcard destination is the narrowest workable rule.
#tfsec:ignore:aws-ec2-no-public-egress-sgr
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS to Temporal Cloud, vendors and VPC endpoints"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "postgres" {
  count = var.database_security_group_id == null ? 0 : 1

  security_group_id            = aws_security_group.this.id
  description                  = "Postgres"
  referenced_security_group_id = var.database_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ---- task definition and service ---------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = var.name
      image     = var.image
      essential = true
      command   = var.command
      portMappings = local.ingress_on ? [
        { containerPort = var.container_port, protocol = "tcp" }
      ] : []
      environment            = [for k, v in var.environment : { name = k, value = v }]
      secrets                = [for k, v in var.secrets : { name = k, valueFrom = v }]
      readonlyRootFilesystem = var.readonly_root_filesystem
      linuxParameters        = { initProcessEnabled = true }
      ulimits                = [{ name = "nofile", softLimit = 65536, hardLimit = 65536 }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "task"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name                               = var.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = local.ingress_on ? 60 : null
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  tags                               = var.tags

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = local.ingress_on ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.this[0].arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  lifecycle {
    # Autoscaling owns desired_count after the first apply.
    ignore_changes = [desired_count]
  }
}

# ---- load balancer integration -----------------------------------------------------------------

resource "aws_lb_target_group" "this" {
  count = local.ingress_on ? 1 : 0

  name                 = substr(var.name, 0, 32)
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    path                = var.ingress.health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener_rule" "this" {
  count = local.ingress_on ? 1 : 0

  listener_arn = var.ingress.listener_arn
  priority     = var.ingress.priority
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[0].arn
  }

  condition {
    host_header {
      values = var.ingress.host_headers
    }
  }

  dynamic "condition" {
    for_each = length(var.ingress.path_patterns) > 0 ? [1] : []
    content {
      path_pattern {
        values = var.ingress.path_patterns
      }
    }
  }
}

# ---- autoscaling -------------------------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity
  tags               = var.tags
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

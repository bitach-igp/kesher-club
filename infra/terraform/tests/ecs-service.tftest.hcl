# Plan-mode checks for modules/ecs-service: private networking, secrets via Secrets Manager only,
# autoscaling bounds.

mock_provider "aws" {
  # Policy documents are validated as JSON at plan time, so the mock must return real JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name            = "kesher-test-api"
  cluster_arn     = "arn:aws:ecs:us-east-1:111111111111:cluster/kesher-test"
  cluster_name    = "kesher-test"
  vpc_id          = "vpc-00000000000000000"
  subnet_ids      = ["subnet-0000000000000000a", "subnet-0000000000000000b", "subnet-0000000000000000c"]
  image           = "111111111111.dkr.ecr.us-east-1.amazonaws.com/kesher/api:test"
  log_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
  secrets = {
    PGPASSWORD = "arn:aws:secretsmanager:us-east-1:111111111111:secret:kesher/test/db-app-password-AbCdEf"
  }
  ingress = {
    listener_arn          = "arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/kesher-test/0000000000000000/0000000000000000"
    alb_security_group_id = "sg-0000000000000000a"
    host_headers          = ["api.test.kesher.example"]
    priority              = 10
  }
}

run "api_service" {
  command = plan

  module {
    source = "./modules/ecs-service"
  }

  assert {
    condition     = aws_ecs_service.this.network_configuration[0].assign_public_ip == false
    error_message = "tasks must not get public IPs"
  }

  assert {
    condition     = aws_ecs_service.this.launch_type == "FARGATE" && aws_ecs_task_definition.this.cpu == "1024" && aws_ecs_task_definition.this.memory == "2048"
    error_message = "api sizing is Fargate 1 vCPU / 2 GB"
  }

  assert {
    condition     = aws_appautoscaling_target.this.min_capacity == 2 && aws_appautoscaling_target.this.max_capacity == 8
    error_message = "api scales 2-8 tasks"
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu.target_tracking_scaling_policy_configuration[0].target_value == 60
    error_message = "CPU target is 60%"
  }

  assert {
    condition     = length(regexall("\"secrets\":\\[\\{\"name\":\"PGPASSWORD\",\"valueFrom\":\"arn:aws:secretsmanager", aws_ecs_task_definition.this.container_definitions)) == 1
    error_message = "secrets must be injected from Secrets Manager"
  }

  assert {
    condition     = length(regexall("PGPASSWORD\",\"value\"", aws_ecs_task_definition.this.container_definitions)) == 0
    error_message = "a secret must never appear as a plain environment value"
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.kms_key_id == var.log_kms_key_arn
    error_message = "log group must be CMK-encrypted"
  }

  assert {
    condition     = length(aws_lb_target_group.this) == 1 && length(aws_lb_listener_rule.this) == 1
    error_message = "ingress attaches a target group and a host rule"
  }
}

run "worker_without_ingress" {
  command = plan

  module {
    source = "./modules/ecs-service"
  }

  variables {
    name         = "kesher-test-worker"
    cpu          = 512
    memory       = 1024
    max_capacity = 6
    ingress      = null
  }

  assert {
    condition     = length(aws_lb_target_group.this) == 0 && length(aws_vpc_security_group_ingress_rule.from_alb) == 0
    error_message = "workers have no inbound path"
  }
}

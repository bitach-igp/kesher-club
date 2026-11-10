# T-0054: modules/alarms against a mocked AWS provider. Applied (not only planned) so that every computed value is known to the
# assertions. The alert table of docs/runbooks/README.md is checked here by RUN number and alert name; apps/api/src/alarms-contract.test.ts
# reads the table itself and fails when a row has no alarm.

mock_provider "aws" {
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:il-central-1:111111111111:kesher-test" }
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

variables {
  name                   = "kesher-test"
  pager_endpoint         = "https://events.pager.example/integration/test/enqueue"
  budget_limit_usd       = 1000
  db_instance_identifier = "kesher-test"
  db_replica_identifier  = "kesher-test-replica"
  certificate_arns       = { platform = "arn:aws:acm:il-central-1:111111111111:certificate/00000000-0000-0000-0000-000000000000" }

  ingress_services = {
    api-il = {
      load_balancer_arn = "arn:aws:elasticloadbalancing:il-central-1:111111111111:loadbalancer/app/kesher-test/0123456789abcdef"
      target_group_arn  = "arn:aws:elasticloadbalancing:il-central-1:111111111111:targetgroup/kesher-test-api-il/0123456789abcdef"
      run               = "RUN-05"
    }
    jit-il = {
      load_balancer_arn = "arn:aws:elasticloadbalancing:il-central-1:111111111111:loadbalancer/app/kesher-test/0123456789abcdef"
      target_group_arn  = "arn:aws:elasticloadbalancing:il-central-1:111111111111:targetgroup/kesher-test-jit-il/fedcba9876543210"
      run               = "RUN-02"
    }
  }

  ecs_services = {
    api-il = { cluster_name = "kesher-test", service_name = "kesher-test-api-il", run = "RUN-05" }
    jit-il = { cluster_name = "kesher-test", service_name = "kesher-test-jit-il", run = "RUN-02" }
  }
}

run "every_alert_row_has_an_alarm_naming_its_run" {
  command = apply

  module {
    source = "./modules/alarms"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "JIT latency") && strcontains(d, "RUN-02")])
    error_message = "the alert table row JIT latency needs an alarm whose description names it and RUN-02"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "JIT errors") && strcontains(d, "RUN-02")])
    error_message = "the alert table row JIT errors needs an alarm whose description names it and RUN-02"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "Webhook lag") && strcontains(d, "RUN-05")])
    error_message = "the alert table row Webhook lag needs an alarm whose description names it and RUN-05"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "Reconciliation break") && strcontains(d, "RUN-03")])
    error_message = "the alert table row Reconciliation break needs an alarm whose description names it and RUN-03"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "Workflow failure") && strcontains(d, "RUN-01") && strcontains(d, "RUN-03")])
    error_message = "the alert table row Workflow failure needs an alarm whose description names it and RUN-01, RUN-03"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "Temporal backlog") && strcontains(d, "RUN-05")])
    error_message = "the alert table row Temporal backlog needs an alarm whose description names it and RUN-05"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "RDS CPU") && strcontains(d, "RUN-02")])
    error_message = "the alert table row RDS CPU needs an alarm whose description names it and RUN-02"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "Certificate expiry") && strcontains(d, "RUN-07")])
    error_message = "the alert table row Certificate expiry needs an alarm whose description names it and RUN-07"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "Port contract check") && strcontains(d, "RUN-01")])
    error_message = "the alert table row Port contract check needs an alarm whose description names it and RUN-01"
  }

  assert {
    condition     = anytrue([for d in output.alarm_descriptions : strcontains(d, "US banking provider") && strcontains(d, "RUN-09")])
    error_message = "the alert table row US banking provider needs an alarm whose description names it and RUN-09"
  }

  assert {
    condition     = alltrue([for d in output.alarm_descriptions : can(regex("RUN-[0-9][0-9]", d))])
    error_message = "every alarm and rule description names a runbook"
  }
}

run "dead_worker_pages" {
  command = apply

  module {
    source = "./modules/alarms"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.job_stale) == 25 && alltrue([for a in values(aws_cloudwatch_metric_alarm.job_stale) : a.treat_missing_data == "breaching" && a.metric_name == "job.age_s" && a.namespace == "Kesher"])
    error_message = "job.age_s is emitted only when a run finishes, so every job's alarm must treat missing data as breaching"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.job_stale["balance-proof"].period == 3600 && aws_cloudwatch_metric_alarm.job_stale["balance-proof"].evaluation_periods == 30 && aws_cloudwatch_metric_alarm.job_stale["load-sweep"].period == 300
    error_message = "daily jobs alarm over a 30 hour window, minute sweeps over five minutes"
  }
}

run "metrics_match_exactly" {
  command = apply

  module {
    source = "./modules/alarms"
  }

  assert {
    condition     = try(length(aws_cloudwatch_metric_alarm.jit_latency.dimensions), 0) == 0 && try(length(aws_cloudwatch_metric_alarm.jit_errors.dimensions), 0) == 0 && aws_cloudwatch_metric_alarm.jit_latency.extended_statistic == "p99"
    error_message = "jit.decision_ms and jit.error carry no dimensions"
  }

  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.webhook_lag["IL"].dimensions)) == toset(["market"]) && toset(keys(aws_cloudwatch_metric_alarm.transfer_stuck["pending_hold-il"].dimensions)) == toset(["state", "market"])
    error_message = "webhook.lag_s carries market; transfer.stuck carries state and market"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.transfer_stuck["pending_hold-il"].threshold > aws_cloudwatch_metric_alarm.transfer_stuck["pending-il"].threshold && aws_cloudwatch_metric_alarm.transfer_stuck["pending_hold-il"].threshold >= 259200
    error_message = "pending_hold holds last days (payout cool-off 24 hours, ACH 3 business days), so its threshold is at least 3 days and above the pending one"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.transfer_stuck) == 8 && length(aws_cloudwatch_metric_alarm.webhook_lag) == 2
    error_message = "one alarm per market and per non-terminal state"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_5xx["jit-il"].dimensions["TargetGroup"] == "targetgroup/kesher-test-jit-il/fedcba9876543210" && aws_cloudwatch_metric_alarm.alb_5xx["jit-il"].dimensions["LoadBalancer"] == "app/kesher-test/0123456789abcdef"
    error_message = "ALB alarms use the ARN suffixes CloudWatch expects as dimensions"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.alb_5xx) == 2 && length(aws_cloudwatch_metric_alarm.alb_unhealthy) == 2 && length(aws_cloudwatch_metric_alarm.ecs_tasks) == 2
    error_message = "one 5xx, unhealthy-host and desired-versus-running alarm per service"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.cert_expiry["platform"].threshold == 14 && aws_cloudwatch_metric_alarm.cert_expiry["platform"].metric_name == "DaysToExpiry" && length(aws_cloudwatch_metric_alarm.rds_replica_lag) == 1
    error_message = "certificates alarm at 14 days to expiry; the replica has a lag alarm"
  }
}

run "paging_budget_and_backups" {
  command = apply

  module {
    source = "./modules/alarms"
  }

  assert {
    condition     = aws_sns_topic_subscription.pager.protocol == "https" && aws_sns_topic_subscription.pager.endpoint == var.pager_endpoint
    error_message = "exactly one pager subscription, to the endpoint variable"
  }

  assert {
    condition     = toset(keys(aws_sns_topic.this)) == toset(["pages", "tickets"]) && alltrue([for t in values(aws_sns_topic.this) : t.kms_master_key_id != "alias/aws/sns" && t.kms_master_key_id != null && t.kms_master_key_id != ""])
    error_message = "both topics are encrypted with a CMK, never the AWS-managed alias/aws/sns key that CloudWatch cannot publish to"
  }

  assert {
    condition     = toset([for n in aws_budgets_budget.monthly.notification : n.threshold]) == toset([50, 80, 100]) && aws_budgets_budget.monthly.limit_amount == "1000"
    error_message = "budget notices at 50, 80 and 100 percent"
  }

  assert {
    condition     = strcontains(aws_cloudwatch_event_rule.backup_failed.event_pattern, "aws.backup") && aws_cloudwatch_event_target.backup_failed.arn == aws_sns_topic.this["pages"].arn
    error_message = "a failed AWS Backup job reaches the page topic"
  }

  assert {
    condition     = length(output.dashboard_names) == 2
    error_message = "two dashboards: money path and infrastructure"
  }
}

run "no_replica_no_lag_alarm" {
  command = apply

  module {
    source = "./modules/alarms"
  }

  variables {
    db_replica_identifier = null
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.rds_replica_lag) == 0
    error_message = "an environment without a replica has no replica-lag alarm"
  }
}

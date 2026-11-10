# Alarms, paging, dashboards and the budget (T-0054). Every row of the alert table in docs/runbooks/README.md
# has an alarm whose description names its RUN number; alarms_contract (apps/api/src/alarms-contract.test.ts) and
# tests/alarms.tftest.hcl fail when one does not. Application alarms match the metrics of packages/domain/src/metrics.ts
# by EXACT namespace, name and dimension set (CloudWatch matches no other): jit.* carry no dimensions, webhook.lag_s
# {market}, transfer.stuck{state,market}, job.failure{job}, job.age_s{job}, provider.error{port}.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  namespace   = "Kesher"
  pages_arn   = aws_sns_topic.this["pages"].arn
  tickets_arn = aws_sns_topic.this["tickets"].arn
  region      = data.aws_region.current.name

  # Every job of apps/worker/src/jobs.ts with its cycle in seconds (a daily job is 86400). `money` jobs page when they fail
  # or go stale; the rest open a ticket. alarms-contract.test.ts fails when this table and the worker's job names differ.
  jobs = {
    "outbox-publish"       = { cycle_s = 10, money = false }
    "metrics-market"       = { cycle_s = 60, money = false }
    "metrics-recon"        = { cycle_s = 60, money = false }
    "card-token-events"    = { cycle_s = 30, money = true }
    "load-sweep"           = { cycle_s = 60, money = true }
    "send-sweep"           = { cycle_s = 60, money = true }
    "payout-sweep"         = { cycle_s = 60, money = true }
    "p2p-release-holds"    = { cycle_s = 60, money = true }
    "fx-void-stale"        = { cycle_s = 60, money = true }
    "webhook-replay"       = { cycle_s = 60, money = true }
    "fx-refresh-rates"     = { cycle_s = 300, money = false }
    "ach-release-holds"    = { cycle_s = 300, money = true }
    "us-funding-sweep"     = { cycle_s = 300, money = true }
    "p2p-expire-requests"  = { cycle_s = 900, money = false }
    "auto-reload"          = { cycle_s = 900, money = true }
    "agent-expire-intents" = { cycle_s = 900, money = false }
    "monitoring"           = { cycle_s = 3600, money = false }
    "card-release-holds"   = { cycle_s = 3600, money = true }
    "esim-usage"           = { cycle_s = 3600, money = false }
    "balance-proof"        = { cycle_s = 86400, money = true }
    "catalogue-sync"       = { cycle_s = 86400, money = false }
    "kyb-rescreen"         = { cycle_s = 86400, money = false }
    "kyb-refresh"          = { cycle_s = 86400, money = false }
    "deposit-reconcile"    = { cycle_s = 86400, money = true }
    "us-banking-recon"     = { cycle_s = 86400, money = true }
    "partner-recon"        = { cycle_s = 86400, money = true }
  }
  money_jobs = { for k, j in local.jobs : k => j if j.money }
  other_jobs = { for k, j in local.jobs : k => j if !j.money }

  # Seconds a transfer may sit in a non-terminal state before the alarm fires: each is above the longest legitimate dwell.
  # created: a transfer is submitted within the request (15 minutes). submitted: the provider answers in seconds to minutes (an
  # hour). pending: an ACH debit waits for the bank, up to 3 business days (ACH_HOLD_BUSINESS_DAYS = 3; 3 business days plus a
  # weekend and a bank holiday is under 6 calendar days, so 6 days). pending_hold: a payout cool-off is 24 hours (COOL_OFF_MS in
  # payouts/service.ts) and an ACH load hold runs 3 business days, so 7 days. No metric says a hold is overdue, only how long the
  # oldest has sat.
  transfer_states = {
    created      = 900
    submitted    = 3600
    pending      = 518400
    pending_hold = 604800
  }
  transfer_stuck = merge([
    for m in var.markets : {
      for s, t in local.transfer_states : "${s}-${lower(m)}" => { state = s, market = m, threshold_s = t }
    }
  ]...)

  # ALB dimension values are the tail of the ARN.
  lb_suffix = { for k, s in var.ingress_services : k => split("loadbalancer/", s.load_balancer_arn)[1] }
  tg_suffix = { for k, s in var.ingress_services : k => "targetgroup/${split("targetgroup/", s.target_group_arn)[1]}" }
}

# ---- topics: pages (to the pager) and tickets, both encrypted with a CMK ------------------------------------------------
# CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed alias/aws/sns key, so the topics use their own CMK
# whose policy lets the CloudWatch, EventBridge, Budgets and SNS service principals encrypt for it.

module "kms" {
  source             = "../kms"
  name               = "${var.name}-alarms"
  description        = "SNS topics for pages and tickets"
  service_principals = ["cloudwatch.amazonaws.com", "events.amazonaws.com", "budgets.amazonaws.com", "sns.amazonaws.com"]
  tags               = var.tags
}

resource "aws_sns_topic" "this" {
  for_each = toset(["pages", "tickets"])

  name              = "${var.name}-${each.key}"
  kms_master_key_id = module.kms.key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "topic" {
  for_each = toset(["pages", "tickets"])

  statement {
    sid       = "ServicesPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.this[each.key].arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com", "budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "this" {
  for_each = toset(["pages", "tickets"])

  arn    = aws_sns_topic.this[each.key].arn
  policy = data.aws_iam_policy_document.topic[each.key].json
}

# The one pager subscription: its endpoint is a required variable. The tickets topic has no subscription here; the team
# subscribes its tracker (an email address or an integration) to it, which is a choice of people, not of this module.
resource "aws_sns_topic_subscription" "pager" {
  topic_arn              = aws_sns_topic.this["pages"].arn
  protocol               = "https"
  endpoint               = var.pager_endpoint
  endpoint_auto_confirms = true
}

# ---- RUN-02: JIT latency and errors (no dimensions) ---------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "jit_latency" {
  alarm_name          = "${var.name}-jit-latency"
  alarm_description   = "JIT latency: p99 of jit.decision_ms over 300 ms for 5 minutes. Runbook RUN-02 (JIT latency or decline spike)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  namespace           = local.namespace
  metric_name         = "jit.decision_ms"
  extended_statistic  = "p99"
  period              = 60
  threshold           = 300
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags
}

# jit.error is 0 or 1 per decision, so its Average is the error rate.
resource "aws_cloudwatch_metric_alarm" "jit_errors" {
  alarm_name          = "${var.name}-jit-errors"
  alarm_description   = "JIT errors: error rate (average of jit.error) over 1% for 5 minutes. Runbook RUN-02 (JIT latency or decline spike)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  namespace           = local.namespace
  metric_name         = "jit.error"
  statistic           = "Average"
  period              = 60
  threshold           = 0.01
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags
}

# ---- RUN-05: webhook lag, per market ------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "webhook_lag" {
  for_each = toset(var.markets)

  alarm_name          = "${var.name}-webhook-lag-${lower(each.key)}"
  alarm_description   = "Webhook lag: oldest unapplied inbound event over 5 minutes in market ${each.key}. Runbook RUN-05 (Webhook backlog)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  namespace           = local.namespace
  metric_name         = "webhook.lag_s"
  statistic           = "Maximum"
  period              = 60
  threshold           = 300
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    market = each.key
  }
}

# Temporal Cloud publishes its task-queue backlog to Prometheus, not to CloudWatch, and the apps emit no such series yet
# (T-0053 left it for this card). The alarm listens for a series a metrics forwarder publishes as Kesher/Temporal
# task_queue_backlog; until one does, missing data is not breaching, so it stays quiet and the gap is on record in T-0054.
resource "aws_cloudwatch_metric_alarm" "temporal_backlog" {
  alarm_name          = "${var.name}-temporal-backlog"
  alarm_description   = "Temporal backlog: more than 1,000 tasks waiting on a task queue. Runbook RUN-05 (Webhook backlog). Needs the Kesher/Temporal task_queue_backlog series."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  namespace           = "${local.namespace}/Temporal"
  metric_name         = "task_queue_backlog"
  statistic           = "Maximum"
  period              = 60
  threshold           = 1000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags
}

# ---- RUN-03: reconciliation breaks (no dimensions) ----------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "recon_break_amount" {
  alarm_name          = "${var.name}-recon-break-amount"
  alarm_description   = "Reconciliation break: open breaks total over 50 USD. Runbook RUN-03 (Reconciliation break)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = local.namespace
  metric_name         = "recon.break_open_usd"
  statistic           = "Maximum"
  period              = 300
  threshold           = 50
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "recon_break_age" {
  alarm_name          = "${var.name}-recon-break-age"
  alarm_description   = "Reconciliation break: the oldest open break is aged over 24 hours. Runbook RUN-03 (Reconciliation break)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = local.namespace
  metric_name         = "recon.break_oldest_h"
  statistic           = "Maximum"
  period              = 300
  threshold           = 24
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags
}

# ---- RUN-01 / RUN-03: workflow failure ----------------------------------------------------------------------------------

# Any failed run of a money job pages. job.failure is emitted only on a failure, so no data is the healthy state.
resource "aws_cloudwatch_metric_alarm" "workflow_failure" {
  for_each = local.money_jobs

  alarm_name          = "${var.name}-workflow-failure-${each.key}"
  alarm_description   = "Workflow failure: a run of money job ${each.key} failed. Runbook RUN-01 (provider outage) if a provider is failing, RUN-03 (reconciliation break) if the books are wrong."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = local.namespace
  metric_name         = "job.failure"
  statistic           = "Sum"
  period              = 300
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    job = each.key
  }
}

resource "aws_cloudwatch_metric_alarm" "job_failure_ticket" {
  for_each = local.other_jobs

  alarm_name          = "${var.name}-job-failure-${each.key}"
  alarm_description   = "Job failure (ticket): a run of job ${each.key} failed. It is not a money job, so it opens a ticket and does not page. Nearest runbook RUN-05 (Webhook backlog: worker health)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = local.namespace
  metric_name         = "job.failure"
  statistic           = "Sum"
  period              = 300
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.tickets_arn]
  tags                = var.tags

  dimensions = {
    job = each.key
  }
}

# A transfer stuck in a non-terminal state is a workflow that stopped moving. transfer.stuck is the age in seconds of the oldest
# transfer in the state and is emitted only for states that have one, so no data is healthy.
resource "aws_cloudwatch_metric_alarm" "transfer_stuck" {
  for_each = local.transfer_stuck

  alarm_name          = "${var.name}-transfer-stuck-${each.key}"
  alarm_description   = "Workflow failure: the oldest ${each.value.state} transfer in market ${each.value.market} has not moved for over ${each.value.threshold_s} seconds. Runbook RUN-01 (provider outage) or RUN-03 (reconciliation break)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  namespace           = local.namespace
  metric_name         = "transfer.stuck"
  statistic           = "Maximum"
  period              = 300
  threshold           = each.value.threshold_s
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    state  = each.value.state
    market = each.value.market
  }
}

# ---- job.age_s: a dead worker pages -------------------------------------------------------------------------------------
# job.age_s is emitted only when a run finishes (0 on success, the seconds since the last success on a failure), so a worker that is
# down emits nothing: missing data is BREACHING. The window covers at least two cycles of the job; a daily job alarms only when
# NONE of 30 hourly periods holds a run (a 30 hour window), so a run up to 6 hours late or shifted by DST does not page.
# The series has no market dimension (T-0053): the IL and US workers share one {job} series, so one dead worker is hidden by the
# other. Per-market dead-worker detection is the ecs_tasks alarm on each worker service; a market dimension on job.age_s is a follow-up.

resource "aws_cloudwatch_metric_alarm" "job_stale" {
  for_each = local.jobs

  alarm_name          = "${var.name}-job-stale-${each.key}"
  alarm_description   = each.key == "us-banking-recon" ? "US banking provider: the US reconciliation has not finished (no run in 30 hours; due 03:00 IL, deadline 06:00 IL), or no worker is reporting. Runbook RUN-09 (US banking provider)." : "Job stale: job ${each.key} has not finished a run in time, or no worker is reporting (a dead worker pages). One dead market worker is seen by the ecs_tasks alarm, not this one. Runbook RUN-05 (Webhook backlog: check worker health, scale workers)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = each.value.cycle_s >= 86400 ? 30 : (each.value.cycle_s >= 900 ? 2 : 3)
  datapoints_to_alarm = each.value.cycle_s >= 86400 ? 30 : (each.value.cycle_s >= 900 ? 2 : 3)
  namespace           = local.namespace
  metric_name         = "job.age_s"
  statistic           = "Maximum"
  period              = each.value.cycle_s >= 3600 ? 3600 : (each.value.cycle_s >= 900 ? 900 : 300)
  threshold           = each.value.cycle_s >= 86400 ? 90000 : 3 * each.value.cycle_s
  treat_missing_data  = "breaching"
  alarm_actions       = each.value.money ? [local.pages_arn] : [local.tickets_arn]
  ok_actions          = each.value.money ? [local.pages_arn] : [local.tickets_arn]
  tags                = var.tags

  dimensions = {
    job = each.key
  }
}

# ---- RUN-01: provider errors per port; RUN-09: the US banking port --------------------------------------------------------
# provider.error counts failed provider calls and no series counts the calls, so the thresholds are counts, not rates.
# The nightly contract suite runs in CI and publishes no metric: these alarms are the runtime half of RUN-01's contract-or-error alert.

resource "aws_cloudwatch_metric_alarm" "port_errors" {
  for_each = toset(var.provider_ports)

  alarm_name          = "${var.name}-port-errors-${each.key}"
  alarm_description   = "Port contract check: provider errors on port ${each.key} (5 or more in 5 minutes). Runbook RUN-01 (Provider outage)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = local.namespace
  metric_name         = "provider.error"
  statistic           = "Sum"
  period              = 300
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    port = each.key
  }
}

resource "aws_cloudwatch_metric_alarm" "us_banking_errors" {
  alarm_name          = "${var.name}-us-banking-errors"
  alarm_description   = "US banking provider: errors on InstitutionBankingPort (5 or more in 5 minutes). Runbook RUN-09 (US banking provider)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = local.namespace
  metric_name         = "provider.error"
  statistic           = "Sum"
  period              = 300
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    port = "institution-banking"
  }
}

# ---- RUN-02: the database ----------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu"
  alarm_description   = "RDS CPU: over 80% for 15 minutes. Runbook RUN-02 (JIT latency or decline spike: check replica lag and DB CPU)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  threshold           = 80
  treat_missing_data  = "missing"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    DBInstanceIdentifier = var.db_instance_identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${var.name}-rds-free-storage"
  alarm_description   = "RDS free storage: under ${var.db_free_storage_min_gib} GiB. Runbook RUN-02 (JIT latency or decline spike); grow the volume before writes stop."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  threshold           = var.db_free_storage_min_gib * 1073741824
  treat_missing_data  = "missing"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    DBInstanceIdentifier = var.db_instance_identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name}-rds-connections"
  alarm_description   = "RDS connections: over ${var.db_max_connections} open for 10 minutes. Runbook RUN-02 (JIT latency or decline spike)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  threshold           = var.db_max_connections
  treat_missing_data  = "missing"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    DBInstanceIdentifier = var.db_instance_identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_replica_lag" {
  count = var.db_replica_identifier == null ? 0 : 1

  alarm_name          = "${var.name}-rds-replica-lag"
  alarm_description   = "RDS replica lag: over 60 seconds for 10 minutes. Runbook RUN-02 (JIT latency or decline spike: check replica lag)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  namespace           = "AWS/RDS"
  metric_name         = "ReplicaLag"
  statistic           = "Maximum"
  period              = 300
  threshold           = 60
  treat_missing_data  = "missing"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    DBInstanceIdentifier = var.db_replica_identifier
  }
}

# ---- RUN-07: certificate expiry ----------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "cert_expiry" {
  for_each = var.certificate_arns

  alarm_name          = "${var.name}-cert-expiry-${each.key}"
  alarm_description   = "Certificate expiry: the ${each.key} certificate expires within 14 days. Runbook RUN-07 (Data incident: rotate before it bites)."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = "AWS/CertificateManager"
  metric_name         = "DaysToExpiry"
  statistic           = "Minimum"
  period              = 86400
  threshold           = 14
  treat_missing_data  = "missing"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    CertificateArn = each.value
  }
}

# ---- load balancers and tasks, per service -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  for_each = var.ingress_services

  alarm_name          = "${var.name}-alb-5xx-${each.key}"
  alarm_description   = "ALB 5xx: service ${each.key} answers 5xx from its targets (10 or more in 5 minutes). Runbook ${each.value.run}."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    LoadBalancer = local.lb_suffix[each.key]
    TargetGroup  = local.tg_suffix[each.key]
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy" {
  for_each = var.ingress_services

  alarm_name          = "${var.name}-alb-unhealthy-${each.key}"
  alarm_description   = "ALB unhealthy hosts: service ${each.key} has a target failing its health check for 5 minutes. Runbook ${each.value.run}."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  dimensions = {
    LoadBalancer = local.lb_suffix[each.key]
    TargetGroup  = local.tg_suffix[each.key]
  }
}

# Container Insights (enabled on the cluster) publishes the desired and running task counts.
resource "aws_cloudwatch_metric_alarm" "ecs_tasks" {
  for_each = var.ecs_services

  alarm_name          = "${var.name}-ecs-tasks-${each.key}"
  alarm_description   = "ECS tasks: service ${each.key} has fewer running tasks than desired for 5 minutes. Runbook ${each.value.run}."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.pages_arn]
  ok_actions          = [local.pages_arn]
  tags                = var.tags

  metric_query {
    id          = "gap"
    expression  = "desired - running"
    label       = "Desired minus running tasks"
    return_data = true
  }

  metric_query {
    id = "desired"

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "DesiredTaskCount"
      period      = 60
      stat        = "Minimum"

      dimensions = {
        ClusterName = each.value.cluster_name
        ServiceName = each.value.service_name
      }
    }
  }

  metric_query {
    id = "running"

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "RunningTaskCount"
      period      = 60
      stat        = "Minimum"

      dimensions = {
        ClusterName = each.value.cluster_name
        ServiceName = each.value.service_name
      }
    }
  }
}

# ---- AWS Backup job and copy job failure -> the page topic --------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "backup_failed" {
  name        = "${var.name}-backup-failed"
  description = "Backup failure: an AWS Backup job failed, expired or aborted. Runbook RUN-08 (Restore from backup): the newest recovery point may be missing."
  tags        = var.tags

  event_pattern = jsonencode({
    source        = ["aws.backup"]
    "detail-type" = ["Backup Job State Change"]
    detail        = { state = ["FAILED", "EXPIRED", "ABORTED"] }
  })
}

resource "aws_cloudwatch_event_target" "backup_failed" {
  rule      = aws_cloudwatch_event_rule.backup_failed.name
  target_id = "pages"
  arn       = local.pages_arn
}

resource "aws_cloudwatch_event_rule" "backup_copy_failed" {
  name        = "${var.name}-backup-copy-failed"
  description = "Backup failure: an AWS Backup copy job to the DR or locked vault failed. Runbook RUN-08 (Restore from backup): the copy may be missing."
  tags        = var.tags

  event_pattern = jsonencode({
    source        = ["aws.backup"]
    "detail-type" = ["Copy Job State Change"]
    detail        = { state = ["FAILED"] }
  })
}

resource "aws_cloudwatch_event_target" "backup_copy_failed" {
  rule      = aws_cloudwatch_event_rule.backup_copy_failed.name
  target_id = "pages"
  arn       = local.pages_arn
}

# ---- budget: notices at 50, 80 and 100 percent of actual monthly spend, to the tickets topic ---------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [local.tickets_arn]
    }
  }

  depends_on = [aws_sns_topic_policy.this]
}

# ---- dashboards --------------------------------------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "money_path" {
  dashboard_name = "${var.name}-money-path"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "JIT decision p99 (ms)"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [[local.namespace, "jit.decision_ms", { stat = "p99", label = "p99" }]]
          annotations = {
            horizontal = [{ label = "300 ms", value = 300 }]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "JIT error rate (average of jit.error)"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [[local.namespace, "jit.error", { stat = "Average", label = "error rate" }]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Webhook lag (s)"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [for m in var.markets : [local.namespace, "webhook.lag_s", "market", m, { stat = "Maximum", label = m }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Oldest stuck transfer by state (s)"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          metrics = [for k, t in local.transfer_stuck : [local.namespace, "transfer.stuck", "state", t.state, "market", t.market, { stat = "Maximum", label = k }]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Open reconciliation breaks (USD, hours)"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          metrics = [
            [local.namespace, "recon.break_open_usd", { stat = "Maximum", label = "open USD" }],
            [local.namespace, "recon.break_oldest_h", { stat = "Maximum", label = "oldest (hours)" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Money job failures and provider errors"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          metrics = concat(
            [for k, _ in local.money_jobs : [local.namespace, "job.failure", "job", k, { stat = "Sum", label = k }]],
            [for p in var.provider_ports : [local.namespace, "provider.error", "port", p, { stat = "Sum", label = p }]],
          )
        }
      },
    ]
  })
}

resource "aws_cloudwatch_dashboard" "infrastructure" {
  dashboard_name = "${var.name}-infrastructure"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "RDS CPU (%) and connections"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_instance_identifier, { stat = "Average", label = "CPU %" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_instance_identifier, { stat = "Maximum", label = "connections", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "RDS free storage (bytes)"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          metrics = [["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", var.db_instance_identifier, { stat = "Minimum", label = "free" }]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "ECS running tasks"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [for k, s in var.ecs_services : ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", s.cluster_name, "ServiceName", s.service_name, { stat = "Minimum", label = k }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "ECS desired tasks"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [for k, s in var.ecs_services : ["ECS/ContainerInsights", "DesiredTaskCount", "ClusterName", s.cluster_name, "ServiceName", s.service_name, { stat = "Minimum", label = k }]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "ALB target 5xx"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          metrics = [for k, s in var.ingress_services : ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.lb_suffix[k], "TargetGroup", local.tg_suffix[k], { stat = "Sum", label = k }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "ALB unhealthy hosts"
          region  = local.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [for k, s in var.ingress_services : ["AWS/ApplicationELB", "UnHealthyHostCount", "LoadBalancer", local.lb_suffix[k], "TargetGroup", local.tg_suffix[k], { stat = "Maximum", label = k }]]
        }
      },
    ]
  })
}

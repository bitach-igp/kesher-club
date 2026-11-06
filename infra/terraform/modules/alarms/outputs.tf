output "pages_topic_arn" {
  value = aws_sns_topic.this["pages"].arn
}

output "tickets_topic_arn" {
  value = aws_sns_topic.this["tickets"].arn
}

output "kms_key_arn" {
  value = module.kms.key_arn
}

output "dashboard_names" {
  value = [aws_cloudwatch_dashboard.money_path.dashboard_name, aws_cloudwatch_dashboard.infrastructure.dashboard_name]
}

# Every alarm's description, so a test can prove each row of the runbook alert table has an alarm that names its RUN.
output "alarm_descriptions" {
  value = concat(
    [aws_cloudwatch_metric_alarm.jit_latency.alarm_description, aws_cloudwatch_metric_alarm.jit_errors.alarm_description],
    [aws_cloudwatch_metric_alarm.temporal_backlog.alarm_description, aws_cloudwatch_metric_alarm.recon_break_amount.alarm_description],
    [aws_cloudwatch_metric_alarm.recon_break_age.alarm_description, aws_cloudwatch_metric_alarm.us_banking_errors.alarm_description],
    [aws_cloudwatch_metric_alarm.rds_cpu.alarm_description, aws_cloudwatch_metric_alarm.rds_free_storage.alarm_description],
    [aws_cloudwatch_metric_alarm.rds_connections.alarm_description, aws_cloudwatch_event_rule.backup_failed.description],
    aws_cloudwatch_metric_alarm.rds_replica_lag[*].alarm_description,
    [for a in aws_cloudwatch_metric_alarm.webhook_lag : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.workflow_failure : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.transfer_stuck : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.job_stale : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.port_errors : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.cert_expiry : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.alb_5xx : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.alb_unhealthy : a.alarm_description],
    [for a in aws_cloudwatch_metric_alarm.ecs_tasks : a.alarm_description],
  )
}

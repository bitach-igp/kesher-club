output "task_definition_arn" {
  description = "Pass to `aws ecs run-task` (without the revision, so the latest is run)."
  value       = aws_ecs_task_definition.this.arn
}

output "task_definition_family" {
  value = aws_ecs_task_definition.this.family
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "container_name" {
  value = "migrate"
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

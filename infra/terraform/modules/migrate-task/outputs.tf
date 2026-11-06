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

output "network_configuration" {
  description = "The awsvpcConfiguration to run the task with: private subnets, this security group, never a public IP."
  value = {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }
}

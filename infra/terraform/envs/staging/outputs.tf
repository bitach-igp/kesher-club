output "api_urls" {
  description = "Each market's API, keyed by market (T-0026)."
  value       = { for k, h in local.market_hosts : k => "https://${h.api}" }
}

output "hosts" {
  value = merge(local.hosts, { markets = local.market_hosts })
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "rds_address" {
  value = module.rds.address
}

output "rds_master_user_secret_arn" {
  value = module.rds.master_user_secret_arn
}

output "secret_arns" {
  description = "Secret containers whose values operators set with put-secret-value."
  value       = module.secrets.arns
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "client_vpn_endpoint_id" {
  value = module.network.client_vpn_endpoint_id
}

output "preview_parameter_prefix" {
  description = "SSM prefix infra/preview reads."
  value       = "/kesher/staging/preview/"
}

output "migrate_task" {
  description = "What `aws ecs run-task` needs to prepare the database (T-0044): the task definition, the cluster, the private subnets and the security group."
  value = {
    task_definition = module.migrate.task_definition_family
    cluster         = aws_ecs_cluster.this.name
    subnets         = module.network.private_subnet_ids
    security_group  = module.migrate.security_group_id
    container       = module.migrate.container_name
  }
}

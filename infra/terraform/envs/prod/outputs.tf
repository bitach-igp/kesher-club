output "api_url" {
  value = "https://${local.hosts.api}"
}

output "hosts" {
  value = local.hosts
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

output "break_glass_role_arn" {
  value = length(aws_iam_role.break_glass) == 0 ? null : aws_iam_role.break_glass[0].arn
}

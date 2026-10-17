output "member_account_ids" {
  description = "Account ids keyed by environment; feed these into envs/staging and envs/prod."
  value       = { for k, a in aws_organizations_account.member : k => a.id }
}

output "deploy_role_arns" {
  description = "Deploy role ARNs the CI role assumes (created by each env root)."
  value       = local.deploy_role_arns
}

output "ci_role_arn" {
  description = "Set this as the AWS_CI_ROLE_ARN repository variable in GitHub."
  value       = module.oidc.role_arn
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "ecr_registry" {
  value = "${var.shared_account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "hosted_zone_id" {
  value = aws_route53_zone.root.zone_id
}

output "hosted_zone_name_servers" {
  description = "Delegate the domain to these at the registrar."
  value       = aws_route53_zone.root.name_servers
}

output "locked_backup_vault_arn" {
  value = aws_backup_vault.locked.arn
}

output "organization_id" {
  value = aws_organizations_organization.this.id
}

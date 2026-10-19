variable "region" {
  type    = string
  default = "us-east-1"
}

variable "dr_region" {
  description = "Region that receives the daily snapshot copy."
  type        = string
  default     = "us-west-2"
}

variable "account_id" {
  description = "club-prod account id (output member_account_ids.prod of envs/shared)."
  type        = string
}

variable "shared_account_id" {
  type = string
}

variable "assume_role_name" {
  description = "Role assumed in the prod account. The first apply uses OrganizationAccountAccessRole; afterwards the kesher-deploy role this root creates."
  type        = string
  default     = "kesher-deploy"
}

variable "domain" {
  description = "Environment domain; hostnames are api./jit./webhooks./admin./app./console. under it."
  type        = string
  default     = "kesher.example"
}

variable "hosted_zone_id" {
  description = "Route 53 zone in club-shared that contains var.domain."
  type        = string
}

variable "ecr_registry" {
  description = "ECR registry host in club-shared, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com."
  type        = string
}

variable "image_tag" {
  description = "Image tag deployed to every service (CI passes the commit SHA)."
  type        = string
}

variable "locked_backup_vault_arn" {
  description = "Vault-locked destination in club-shared (output of envs/shared)."
  type        = string
}

variable "webhook_provider_cidrs" {
  description = "Provider egress ranges allowed to reach the webhook listener. Empty disables the listener."
  type        = list(string)
  default     = []
}

variable "temporal_address" {
  description = "Temporal Cloud gRPC endpoint for this environment's namespace."
  type        = string
}

variable "temporal_namespace" {
  type = string
}

variable "identity_center_saml_metadata" {
  description = "SAML metadata XML of the Identity Center application for Client VPN; null leaves the VPN off."
  type        = string
  default     = null
}

variable "db_instance_class" {
  type    = string
  default = "db.r7g.large"
}

variable "create_read_replica" {
  type    = bool
  default = true
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "break_glass_principal_arns" {
  description = "Identity Center permission-set role ARNs in club-shared allowed to assume the break-glass role (MFA enforced by Identity Center)."
  type        = list(string)
  default     = []
}

# The admin console's Identity Center OIDC application (T-0914). The ID token's audience is the client id.
variable "admin_oidc_issuer" {
  description = "Issuer URL of the Identity Center OIDC application the admin console signs in with."
  type        = string
}

variable "admin_oidc_client_id" {
  description = "Client id of that application; also the audience of the ID tokens the console verifies."
  type        = string
}

variable "admin_oidc_jwks_url" {
  description = "JWKS URL the console verifies ID tokens against."
  type        = string
}

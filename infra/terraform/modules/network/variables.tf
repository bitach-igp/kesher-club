variable "name" {
  type = string
}

variable "cidr" {
  description = "VPC CIDR; must be at least a /20 so the nine /20-relative subnets fit (use a /16)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Exactly three AZs in the provider region."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]

  validation {
    condition     = length(var.availability_zones) == 3
    error_message = "The spec requires three availability zones."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (staging cost saving) instead of one per AZ."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "Interface endpoint service names."
  type        = list(string)
  default     = ["secretsmanager", "kms", "ecr.api", "ecr.dkr", "logs"]
}

variable "log_kms_key_arn" {
  description = "CMK for the flow-log and VPN CloudWatch log groups."
  type        = string
}

variable "flow_log_retention_days" {
  type    = number
  default = 90
}

variable "client_vpn" {
  description = "Client VPN settings; null disables it. saml_provider_arn is the Identity Center application's IAM SAML provider."
  type = object({
    server_certificate_arn = string
    saml_provider_arn      = string
    client_cidr            = optional(string, "10.255.0.0/22")
    access_group_id        = optional(string)
  })
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

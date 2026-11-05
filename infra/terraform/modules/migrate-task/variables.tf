variable "name" {
  description = "Prefix for every resource, e.g. kesher-staging-migrate."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  description = "The VPC range the task may reach on 443 (ECR, Secrets Manager and Logs endpoints)."
  type        = string
}

variable "image" {
  description = "The kesher/migrate image with its tag."
  type        = string
}

variable "rds_security_group_id" {
  type = string
}

variable "rds_address" {
  type = string
}

variable "rds_port" {
  type = number
}

variable "database_name" {
  type = string
}

variable "master_secret_arn" {
  description = "The RDS-managed master secret (JSON username and password). The task connects with it to create roles."
  type        = string
}

variable "secrets" {
  description = "Environment variable name to Secrets Manager ARN: the four service-role passwords."
  type        = map(string)
}

variable "rds_kms_key_arn" {
  description = "CMK of the RDS-managed master secret."
  type        = string
}

variable "secret_kms_key_arns" {
  description = "CMKs that encrypt the secrets."
  type        = list(string)
}

variable "log_kms_key_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}

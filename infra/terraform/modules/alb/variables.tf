variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "subnet_ids" {
  description = "Public subnets for an internet-facing ALB, private subnets for an internal one."
  type        = list(string)
}

variable "internal" {
  type    = bool
  default = false
}

variable "certificate_arn" {
  type = string
}

variable "access_logs_bucket" {
  description = "S3 bucket (SSE-S3, ELB log delivery policy) for access logs."
  type        = string
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "webhook_listener" {
  description = "Dedicated provider-webhook listener; null disables it."
  type = object({
    port          = optional(number, 8443)
    allowed_cidrs = list(string)
    path_prefix   = optional(string, "/webhooks/")
  })
  default = null
}

variable "managed_rule_groups" {
  type = list(string)
  default = [
    "AWSManagedRulesCommonRuleSet",
    "AWSManagedRulesKnownBadInputsRuleSet",
    "AWSManagedRulesAmazonIpReputationList",
  ]
}

variable "rate_limit_per_5_minutes" {
  type    = number
  default = 2000
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

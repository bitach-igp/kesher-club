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

variable "allowed_security_group_ids" {
  description = "Internal ALB only. When non-empty, replaces the VPC-CIDR ingress: only these security groups may connect (T-0069)."
  type        = list(string)
  default     = []
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

variable "large_body_route" {
  description = <<-EOT
    The one route allowed past the common rule set's SizeRestrictions_BODY (bodies over 8 KB): POST to a host and a path.
    `host` is the exact lowercase Host header; `path_regex` is a full-match RE2 expression on the URI path.
    null (the default) keeps the rule blocking everywhere. Every other route still blocks oversized bodies.
  EOT
  type = object({
    host       = string
    path_regex = string
    method     = optional(string, "POST")
  })
  default = null
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

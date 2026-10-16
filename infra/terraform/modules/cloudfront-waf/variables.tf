variable "name" {
  type = string
}

variable "bucket_name" {
  description = "Globally unique origin bucket name."
  type        = string
}

variable "domain_names" {
  description = "Aliases served by the distribution; the certificate must cover them."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate in us-east-1."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK for the origin bucket."
  type        = string
}

variable "s3_access_log_bucket" {
  description = "Bucket that receives S3 server access logs for the origin bucket."
  type        = string
}

variable "cloudfront_log_bucket_domain_name" {
  description = "Bucket domain name (SSE-S3, ACL-enabled) for CloudFront standard logs."
  type        = string
}

variable "content_security_policy" {
  type    = string
  default = "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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
  default = 5000
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "tags" {
  type    = map(string)
  default = {}
}

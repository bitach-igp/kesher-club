variable "github_repository" {
  description = "owner/repo that may assume the CI role."
  type        = string
}

variable "role_name" {
  type    = string
  default = "kesher-github-ci"
}

variable "allowed_subjects" {
  description = "Subject suffixes (after repo:owner/repo:) allowed to assume the role."
  type        = list(string)
  default = [
    "ref:refs/heads/main",
    "pull_request",
    "environment:staging",
    "environment:prod",
  ]
}

variable "thumbprints" {
  description = "GitHub OIDC root CA thumbprints. AWS no longer validates these for GitHub, but the API still requires at least one value."
  type        = list(string)
  default     = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

variable "ecr_repository_arns" {
  type = list(string)
}

variable "assumable_role_arns" {
  description = "Deploy role ARNs in club-staging and club-prod the CI role may assume."
  type        = list(string)
}

variable "hosted_zone_arns" {
  description = "Route 53 hosted zone ARNs the CI role may write records in (ACM validation, preview hostnames)."
  type        = list(string)
  default     = []
}

variable "state_bucket_arn" {
  type = string
}

variable "state_lock_table_arn" {
  type = string
}

variable "state_kms_key_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

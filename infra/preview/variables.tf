variable "pr_number" {
  description = "Pull request number; names every resource and the preview hostname."
  type        = number

  validation {
    condition     = var.pr_number >= 1 && var.pr_number <= 48999
    error_message = "pr_number must be between 1 and 48999 (it becomes an ALB listener-rule priority)."
  }
}

variable "image_tag" {
  description = "Tag of the api and worker images pushed for this PR (pr-<n>-<sha>)."
  type        = string
}

variable "staging_account_id" {
  type = string
}

variable "shared_account_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "assume_role_name" {
  description = "Role assumed in club-staging (the deploy role created by infra/terraform/envs/staging)."
  type        = string
  default     = "kesher-deploy"
}

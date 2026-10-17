variable "region" {
  type    = string
  default = "us-east-1"
}

variable "shared_account_id" {
  description = "club-shared, which is also the Organization management account."
  type        = string
}

variable "member_accounts" {
  description = "Member accounts to create under the Organization, keyed by environment name."
  type = map(object({
    name  = string
    email = string
  }))
  default = {
    staging = { name = "club-staging", email = "aws+club-staging@kesher.example" }
    prod    = { name = "club-prod", email = "aws+club-prod@kesher.example" }
  }
}

variable "root_domain" {
  description = "Public hosted zone managed in club-shared."
  type        = string
  default     = "kesher.example"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI role."
  type        = string
}

variable "ecr_repositories" {
  type    = list(string)
  default = ["api", "worker", "admin"]
}

variable "state_bucket_name" {
  type    = string
  default = "kesher-club-tfstate"
}

variable "lock_table_name" {
  type    = string
  default = "kesher-club-tfstate-lock"
}

variable "allowed_regions" {
  description = "Regions the SCP permits for regional services."
  type        = list(string)
  default     = ["us-east-1", "us-west-2"]
}

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

  # AWS sends each new account's root sign-in to this address. The defaults are placeholders on a reserved domain nobody owns.
  validation {
    condition     = alltrue([for a in values(var.member_accounts) : !endswith(lower(a.email), ".example")])
    error_message = "member_accounts must use real root e-mail addresses you control, not the .example placeholders (T-0057)."
  }
}

variable "root_domain" {
  description = "Public hosted zone managed in club-shared. Pass the real domain: the .example placeholder is refused."
  type        = string
  default     = "kesher.example"

  validation {
    condition     = !endswith(lower(var.root_domain), ".example")
    error_message = "root_domain must be the real domain you own (T-0057); .example is a reserved placeholder."
  }
}

variable "dmarc_report_address" {
  description = "Mailbox that receives DMARC aggregate reports. No default: someone must own it."
  type        = string
}

variable "dmarc_policy" {
  description = "none at first; quarantine after two clean weeks of reports (docs/setup/domain.md)."
  type        = string
  default     = "none"
}

variable "postmark_dkim" {
  description = "Postmark DKIM selector and public-key TXT value, from the sender signature page. Null until the sender exists there."
  type = object({
    selector = string
    value    = string
  })
  default = null
}

variable "caa_report_address" {
  description = "Optional mailbox for certificate-issuance violations."
  type        = string
  default     = null
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI role."
  type        = string
}

variable "ecr_repositories" {
  type    = list(string)
  default = ["api", "worker", "admin", "console", "migrate"]
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

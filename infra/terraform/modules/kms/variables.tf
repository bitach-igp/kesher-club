variable "name" {
  description = "Alias name (without the alias/ prefix), e.g. kesher-prod-rds."
  type        = string
}

variable "description" {
  description = "What the key protects."
  type        = string
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled deletion completes."
  type        = number
  default     = 30
}

variable "service_principals" {
  description = "AWS service principals allowed to use the key (e.g. logs.us-east-1.amazonaws.com)."
  type        = list(string)
  default     = []
}

variable "cross_account_ids" {
  description = "Account IDs allowed to decrypt/re-encrypt with this key, used for cross-account backup copies."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

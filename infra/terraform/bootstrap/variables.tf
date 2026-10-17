variable "region" {
  type    = string
  default = "us-east-1"
}

variable "shared_account_id" {
  description = "club-shared account id; the provider refuses to run anywhere else."
  type        = string
}

variable "state_bucket_name" {
  type    = string
  default = "kesher-club-tfstate"
}

variable "lock_table_name" {
  type    = string
  default = "kesher-club-tfstate-lock"
}

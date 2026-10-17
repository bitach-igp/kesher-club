variable "prefix" {
  description = "Secret name prefix, e.g. kesher/staging."
  type        = string
}

variable "names" {
  description = "Logical secret names created under the prefix."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "CMK that encrypts the secrets."
  type        = string
}

variable "region" {
  description = "Region used in the kms:ViaService condition of the read policy."
  type        = string
  default     = "us-east-1"
}

variable "recovery_window_in_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}

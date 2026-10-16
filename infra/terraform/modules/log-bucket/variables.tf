variable "name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "retention_days" {
  type    = number
  default = 400
}

variable "tags" {
  type    = map(string)
  default = {}
}

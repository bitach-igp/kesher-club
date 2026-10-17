variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Isolated database subnets."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to open 5432. More can be added from outside via the exported security_group_id."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "CMK for storage, Performance Insights and the managed master secret."
  type        = string
}

variable "engine_version" {
  type    = string
  default = "16"
}

variable "instance_class" {
  type    = string
  default = "db.r7g.large"
}

variable "replica_instance_class" {
  type    = string
  default = null
}

variable "allocated_storage" {
  type    = number
  default = 200
}

variable "max_allocated_storage" {
  type    = number
  default = 1000
}

variable "multi_az" {
  type    = bool
  default = true
}

variable "backup_retention_period" {
  description = "PITR window in days (spec: 35)."
  type        = number
  default     = 35
}

variable "backup_window" {
  type    = string
  default = "02:00-03:00"
}

variable "maintenance_window" {
  type    = string
  default = "sun:04:00-sun:05:00"
}

variable "database_name" {
  type    = string
  default = "club"
}

variable "master_username" {
  type    = string
  default = "club_admin"
}

variable "create_read_replica" {
  type    = bool
  default = true
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

variable "performance_insights_retention_period" {
  type    = number
  default = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}

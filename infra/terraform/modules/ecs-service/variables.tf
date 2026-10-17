variable "name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets for the tasks."
  type        = list(string)
}

variable "image" {
  description = "Full image reference including tag or digest."
  type        = string
}

variable "command" {
  description = "Optional container command override (e.g. the jit entrypoint on the api image)."
  type        = list(string)
  default     = null
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "cpu" {
  description = "Task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "memory" {
  description = "Task memory in MiB."
  type        = number
  default     = 2048
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "min_capacity" {
  type    = number
  default = 2
}

variable "max_capacity" {
  type    = number
  default = 8
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "environment" {
  description = "Plain environment variables. Never put a secret here; use `secrets`."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Env var name -> Secrets Manager ARN (optionally with :json-key:: suffix)."
  type        = map(string)
  default     = {}
}

variable "secret_kms_key_arns" {
  description = "CMKs the execution role must decrypt to read `secrets`."
  type        = list(string)
  default     = []
}

variable "task_policy_json" {
  description = "Inline IAM policy for the task (application) role."
  type        = string
  default     = null
}

variable "database_security_group_id" {
  description = "RDS security group the tasks may reach on 5432."
  type        = string
  default     = null
}

variable "readonly_root_filesystem" {
  description = "Mount the container root read-only. Turn off only for an image that must write outside a volume."
  type        = bool
  default     = true
}

variable "log_kms_key_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "ingress" {
  description = "ALB attachment; null for workers without inbound traffic."
  type = object({
    listener_arn          = string
    alb_security_group_id = string
    host_headers          = list(string)
    path_patterns         = optional(list(string), [])
    priority              = number
    health_check_path     = optional(string, "/healthz")
  })
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

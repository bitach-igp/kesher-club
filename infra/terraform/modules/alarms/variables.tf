variable "name" {
  description = "Prefix for every alarm, topic, rule, dashboard and budget, e.g. kesher-prod."
  type        = string
}

variable "pager_endpoint" {
  description = "HTTPS endpoint of the pager integration (PagerDuty or Opsgenie events URL). Required: there is no default, so an environment cannot be applied without choosing where pages go."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.pager_endpoint, "https://")
    error_message = "The pager endpoint must be an https:// URL."
  }
}

variable "markets" {
  description = "Market codes the app emits per-market metrics for (the MARKET dimension: IL and US)."
  type        = list(string)
  default     = ["IL", "US"]
}

variable "provider_ports" {
  description = "Provider ports that emit provider.error{port} (apps/api/src/cards/jit.ts emits card-issuing; add a port when its call site emits)."
  type        = list(string)
  default     = ["card-issuing"]
}

variable "ingress_services" {
  description = "Services behind an ALB target group, by a plan-time-known key: the ALB and target group ARNs and the RUN number their alarms name."
  type = map(object({
    load_balancer_arn = string
    target_group_arn  = string
    run               = string
  }))
  default = {}
}

variable "ecs_services" {
  description = "ECS services whose desired and running task counts are compared, by a plan-time-known key, with the RUN number their alarm names."
  type = map(object({
    cluster_name = string
    service_name = string
    run          = string
  }))
  default = {}
}

variable "db_instance_identifier" {
  description = "Primary RDS instance identifier."
  type        = string
}

variable "db_replica_identifier" {
  description = "Read replica identifier; null when the environment has none (no replica-lag alarm)."
  type        = string
  default     = null
}

variable "db_free_storage_min_gib" {
  description = "Free storage, in GiB, under which the database pages."
  type        = number
  default     = 20
}

variable "db_max_connections" {
  description = "Open connections over which the database pages (set to about 80% of the instance class's max_connections)."
  type        = number
  default     = 150
}

variable "certificate_arns" {
  description = "ACM certificates to watch for expiry, by a plan-time-known key."
  type        = map(string)
  default     = {}
}

variable "budget_limit_usd" {
  description = "Monthly cost budget in USD; notices go to the tickets topic at 50, 80 and 100 percent of actual spend."
  type        = number
}

variable "tags" {
  type    = map(string)
  default = {}
}

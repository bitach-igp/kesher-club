output "preview_url" {
  description = "Base URL of the preview API (the OpenAPI server path /v1 sits under it)."
  value       = local.url
}

output "hostname" {
  value = local.hostname
}

output "database_name" {
  value = local.db_name
}

output "api_service_name" {
  value = module.api.service_name
}

output "worker_service_name" {
  value = module.worker.service_name
}

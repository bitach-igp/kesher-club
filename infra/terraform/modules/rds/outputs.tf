output "instance_arn" {
  value = aws_db_instance.this.arn
}

output "instance_identifier" {
  value = aws_db_instance.this.identifier
}

output "address" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_name" {
  value = aws_db_instance.this.db_name
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret (JSON username/password) that RDS manages and rotates."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "replica_address" {
  value = var.create_read_replica ? aws_db_instance.replica[0].address : null
}

output "security_group_id" {
  value = aws_security_group.this.id
}

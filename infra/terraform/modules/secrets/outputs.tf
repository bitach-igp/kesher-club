output "arns" {
  description = "Map of logical name to secret ARN."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "read_policy_json" {
  description = "IAM policy document granting read access to these secrets and decrypt on their key."
  value       = data.aws_iam_policy_document.read.json
}

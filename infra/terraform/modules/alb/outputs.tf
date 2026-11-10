output "arn" {
  value = aws_lb.this.arn
}

output "dns_name" {
  value = aws_lb.this.dns_name
}

output "zone_id" {
  value = aws_lb.this.zone_id
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "https_listener_arn" {
  value = aws_lb_listener.https.arn
}

output "webhook_listener_arn" {
  value = var.webhook_listener == null ? null : aws_lb_listener.webhooks[0].arn
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}

output "security_group_ingress_rule_count" {
  description = "How many security-group-sourced HTTPS ingress rules the ALB has (T-0069)."
  value       = length(aws_vpc_security_group_ingress_rule.https_from_security_group)
}

output "vpc_cidr_ingress" {
  description = "Whether the ALB admits the whole VPC CIDR (internal ALB with no allowed security group)."
  value       = length(aws_vpc_security_group_ingress_rule.https_internal) > 0
}

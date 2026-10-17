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

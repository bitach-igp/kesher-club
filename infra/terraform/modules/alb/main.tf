# Application Load Balancer with an HTTPS-only listener (TLS 1.3 policy), access logs, a regional
# WAF web ACL (AWS managed rule groups + rate limit) and an optional dedicated webhook listener
# whose security group only admits the provider IP allow-list. Internal ALBs (admin) accept
# traffic only from inside the VPC, which in practice means Client VPN users.

resource "aws_security_group" "this" {
  name        = var.name
  description = "${var.name} load balancer"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = var.name })
}

# Public API entry point: this is the single 0.0.0.0/0 ingress the spec allows (ALB 443).
#tfsec:ignore:aws-ec2-no-public-ingress-sgr
resource "aws_vpc_security_group_ingress_rule" "https_public" {
  count = var.internal ? 0 : 1

  security_group_id = aws_security_group.this.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "https_internal" {
  count = var.internal ? 1 : 0

  security_group_id = aws_security_group.this.id
  description       = "HTTPS from inside the VPC (Client VPN)"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "webhooks" {
  for_each = var.webhook_listener == null ? toset([]) : toset(var.webhook_listener.allowed_cidrs)

  security_group_id = aws_security_group.this.id
  description       = "Webhook listener from provider ${each.key}"
  cidr_ipv4         = each.key
  from_port         = var.webhook_listener.port
  to_port           = var.webhook_listener.port
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "to_vpc" {
  security_group_id = aws_security_group.this.id
  description       = "Targets inside the VPC"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
}

# Internet-facing when internal=false: the API ALB is the platform's one public entry point (spec §9).
#tfsec:ignore:aws-elb-alb-not-public
resource "aws_lb" "this" {
  name                       = var.name
  internal                   = var.internal
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.this.id]
  subnets                    = var.subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
  tags                       = merge(var.tags, { Name = var.name })

  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = var.name
    enabled = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  tags              = var.tags

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"type\":\"about:blank\",\"title\":\"Not Found\",\"status\":404}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener" "webhooks" {
  count = var.webhook_listener == null ? 0 : 1

  load_balancer_arn = aws_lb.this.arn
  port              = var.webhook_listener.port
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  tags              = var.tags

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"type\":\"about:blank\",\"title\":\"Not Found\",\"status\":404}"
      status_code  = "404"
    }
  }
}

# ---- WAF ---------------------------------------------------------------------------------------

resource "aws_wafv2_ip_set" "webhook_providers" {
  count = var.webhook_listener == null ? 0 : 1

  name               = "${var.name}-webhook-providers"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.webhook_listener.allowed_cidrs
  tags               = var.tags
}

resource "aws_wafv2_web_acl" "this" {
  name  = var.name
  scope = "REGIONAL"
  tags  = var.tags

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5_minutes
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = { for i, g in var.managed_rule_groups : g => i + 10 }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  # Webhook paths are reachable only from the provider allow-list, whichever listener they hit.
  dynamic "rule" {
    for_each = var.webhook_listener == null ? [] : [1]
    content {
      name     = "webhooks-provider-allowlist"
      priority = 100
      action {
        block {}
      }
      statement {
        and_statement {
          statement {
            byte_match_statement {
              positional_constraint = "STARTS_WITH"
              search_string         = var.webhook_listener.path_prefix
              field_to_match {
                uri_path {}
              }
              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
          statement {
            not_statement {
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.webhook_providers[0].arn
                }
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "webhooks-provider-allowlist"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

resource "aws_cloudwatch_log_group" "waf" {
  # WAF requires the aws-waf-logs- prefix.
  name              = "aws-waf-logs-${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}

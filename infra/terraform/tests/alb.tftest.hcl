# T-0068: modules/alb's WAF against a mocked AWS provider. The common rule set stays in, and its SizeRestrictions_BODY rule (bodies
# over 8 KB) is relaxed only for the one route a variable names; a separate rule blocks the same label on every other route.
# apps/api/src/infra-contract.test.ts reads the same .tf files, so the proof also runs where terraform is not installed.

mock_provider "aws" {
}

variables {
  name               = "kesher-test"
  vpc_id             = "vpc-00000000000000000"
  vpc_cidr           = "10.0.0.0/16"
  subnet_ids         = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
  certificate_arn    = "arn:aws:acm:il-central-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  access_logs_bucket = "kesher-test-logs"
  log_kms_key_arn    = "arn:aws:kms:il-central-1:111111111111:key/00000000-0000-0000-0000-000000000000"
}

run "no_exemption_by_default" {
  command = plan

  module {
    source = "./modules/alb"
  }

  assert {
    condition     = contains([for r in aws_wafv2_web_acl.this.rule : r.name], "AWSManagedRulesCommonRuleSet")
    error_message = "the common rule set stays in the web ACL"
  }

  assert {
    condition     = length(flatten([for r in aws_wafv2_web_acl.this.rule : r.statement[0].managed_rule_group_statement[*].rule_action_override])) == 0
    error_message = "T-0068: with no exempt route no managed rule is overridden, SizeRestrictions_BODY blocks everywhere"
  }

  assert {
    condition     = length([for r in aws_wafv2_web_acl.this.rule : r if startswith(r.name, "body-size-outside-exempt-")]) == 0
    error_message = "T-0068: no exemption, no companion rule"
  }
}

run "one_route_exempted" {
  command = plan

  module {
    source = "./modules/alb"
  }

  variables {
    large_body_route = {
      host       = "api-il.test.example"
      path_regex = "^/v1/institutions/[0-9a-f-]+/rosters$"
    }
  }

  # The rule group is still there, with exactly one override: that one rule, to count.
  assert {
    condition     = length([for r in aws_wafv2_web_acl.this.rule : r if r.name == "AWSManagedRulesCommonRuleSet"]) == 1
    error_message = "T-0068: the rule group is not removed"
  }

  assert {
    condition = (
      [for o in one([for r in aws_wafv2_web_acl.this.rule : r if r.name == "AWSManagedRulesCommonRuleSet"]).statement[0].managed_rule_group_statement[0].rule_action_override : o.name] == ["SizeRestrictions_BODY"]
      && length(one([for r in aws_wafv2_web_acl.this.rule : r if r.name == "AWSManagedRulesCommonRuleSet"]).statement[0].managed_rule_group_statement[0].rule_action_override[0].action_to_use[0].count) == 1
      && length(one([for r in aws_wafv2_web_acl.this.rule : r if r.name == "AWSManagedRulesCommonRuleSet"]).statement[0].managed_rule_group_statement[0].rule_action_override[0].action_to_use[0].block) == 0
    )
    error_message = "T-0068: the only override is SizeRestrictions_BODY set to count"
  }

  # The other groups are untouched.
  assert {
    condition     = alltrue([for r in aws_wafv2_web_acl.this.rule : length(r.statement[0].managed_rule_group_statement[0].rule_action_override) == 0 if r.name != "AWSManagedRulesCommonRuleSet" && length(r.statement[0].managed_rule_group_statement) > 0])
    error_message = "T-0068: no other managed rule group is overridden"
  }

  # What the override relaxes is blocked again, everywhere but the one route: one rule per condition, after the managed groups.
  # Each assertion filters by name before it indexes, so nothing indexes a rule that lacks the block.
  assert {
    condition = alltrue([
      for n in ["host", "path", "method"] :
      length([for r in aws_wafv2_web_acl.this.rule : r.priority if r.name == "body-size-outside-exempt-${n}"]) == 1
    ])
    error_message = "T-0068: one blocking rule each for host, path and method"
  }

  assert {
    condition = alltrue([
      for r in [for r in aws_wafv2_web_acl.this.rule : r if startswith(r.name, "body-size-outside-exempt-")] :
      r.priority > 12 && length(r.action[0].block) == 1 && length(r.statement[0].and_statement[0].statement) == 2 && length(r.statement[0].and_statement[0].statement[0].label_match_statement) == 1 && length(r.statement[0].and_statement[0].statement[1].not_statement) == 1
    ])
    error_message = "T-0068: each companion rule blocks after the managed groups: the label and not one exemption condition"
  }

  assert {
    condition = alltrue([
      for r in [for r in aws_wafv2_web_acl.this.rule : r if startswith(r.name, "body-size-outside-exempt-")] :
      r.statement[0].and_statement[0].statement[0].label_match_statement[0].key == "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
    ])
    error_message = "T-0068: the companion rules match the SizeRestrictions_BODY label"
  }

  assert {
    condition     = length([for r in aws_wafv2_web_acl.this.rule : r if startswith(r.name, "body-size-outside-exempt-")]) == 3
    error_message = "T-0068: exactly host, path and method, nothing else"
  }
}

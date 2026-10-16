# Secrets Manager containers for one environment. Terraform creates the *containers* only; values
# are written out of band (aws secretsmanager put-secret-value) by an operator or a rotation
# job, so no secret ever passes through tfvars or state (Tab 3 §9, constitution art. 6).

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.names)

  name                    = "${var.prefix}/${each.key}"
  description             = "Kesher ${var.prefix} secret ${each.key}; value managed outside Terraform"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = merge(var.tags, { Name = "${var.prefix}/${each.key}" })
}

data "aws_iam_policy_document" "read" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [for s in aws_secretsmanager_secret.this : s.arn]
  }

  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

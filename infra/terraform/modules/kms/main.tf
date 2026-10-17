# Customer-managed KMS key with rotation, an alias and a policy that lets named AWS service
# principals and (optionally) other accounts in the Organization use it for backup copies.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = length(var.service_principals) > 0 ? [1] : []
    content {
      sid = "ServiceUse"
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = var.service_principals
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.cross_account_ids) > 0 ? [1] : []
    content {
      sid = "CrossAccountBackupCopy"
      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:CreateGrant",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
      ]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = [for id in var.cross_account_ids : "arn:${data.aws_partition.current.partition}:iam::${id}:root"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  description             = var.description
  deletion_window_in_days = var.deletion_window_in_days
  enable_key_rotation     = true
  multi_region            = false
  policy                  = data.aws_iam_policy_document.key.json
  tags                    = merge(var.tags, { Name = var.name })
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

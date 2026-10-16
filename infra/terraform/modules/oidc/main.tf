# GitHub Actions OIDC trust: one identity provider and one CI role. No long-lived access keys
# exist anywhere in the platform. The role can push images to the listed ECR repositories, manage
# records in the listed hosted zones, read/write Terraform state and assume the per-account
# deploy roles (club-staging, club-prod) that the environment roots create.

data "aws_partition" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.thumbprints
  tags            = var.tags
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for s in var.allowed_subjects : "repo:${var.github_repository}:${s}"]
    }
  }
}

resource "aws_iam_role" "ci" {
  name                 = var.role_name
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = var.tags
}

data "aws_iam_policy_document" "ci" {
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = var.ecr_repository_arns
  }

  # GetAuthorizationToken is account-scoped and only accepts "*" as a resource.
  #tfsec:ignore:aws-iam-no-policy-wildcards
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "AssumeDeployRoles"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = var.assumable_role_arns
  }

  statement {
    sid = "TerraformStateBucket"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketVersioning",
    ]
    resources = [var.state_bucket_arn]
  }

  # State objects are keyed per root (envs/*.tfstate) and per preview (preview/pr-*.tfstate).
  #tfsec:ignore:aws-iam-no-policy-wildcards
  statement {
    sid       = "TerraformStateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.state_bucket_arn}/*"]
  }

  statement {
    sid       = "TerraformStateLock"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"]
    resources = [var.state_lock_table_arn]
  }

  statement {
    sid       = "TerraformStateKey"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.state_kms_key_arn]
  }

  dynamic "statement" {
    for_each = length(var.hosted_zone_arns) > 0 ? [1] : []
    content {
      sid       = "Route53Records"
      actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetHostedZone"]
      resources = var.hosted_zone_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.hosted_zone_arns) > 0 ? [1] : []
    content {
      sid       = "Route53Read"
      actions   = ["route53:GetChange", "route53:ListHostedZones", "route53:ListHostedZonesByName"]
      resources = ["arn:${data.aws_partition.current.partition}:route53:::change/*"]
    }
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "${var.role_name}-permissions"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.ci.json
}

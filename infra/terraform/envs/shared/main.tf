# club-shared: Organization management, ECR, Route 53, CI OIDC role, org CloudTrail, Security
# Hub and the vault-locked backup destination. No workloads run here.

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.shared_account_id]
  default_tags {
    tags = {
      Project     = "kesher-club"
      Environment = "shared"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_partition" "current" {}

locals {
  deploy_role_arns = { for k, a in aws_organizations_account.member : k => "arn:${data.aws_partition.current.partition}:iam::${a.id}:role/kesher-deploy" }
  member_ids       = [for a in aws_organizations_account.member : a.id]
}

# ---- Organization ------------------------------------------------------------------------------

resource "aws_organizations_organization" "this" {
  feature_set = "ALL"
  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "securityhub.amazonaws.com",
    "backup.amazonaws.com",
    "sso.amazonaws.com",
  ]
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]
}

resource "aws_organizations_account" "member" {
  for_each = var.member_accounts

  name                       = each.value.name
  email                      = each.value.email
  role_name                  = "OrganizationAccountAccessRole"
  iam_user_access_to_billing = "DENY"
  close_on_deletion          = false
  tags                       = { Environment = each.key }

  lifecycle {
    ignore_changes = [role_name]
  }
}

data "aws_iam_policy_document" "scp" {
  statement {
    sid       = "DenyLeavingOrganization"
    effect    = "Deny"
    actions   = ["organizations:LeaveOrganization"]
    resources = ["*"]
  }

  statement {
    sid    = "ProtectAuditTrailAndGuardrails"
    effect = "Deny"
    actions = [
      "cloudtrail:StopLogging",
      "cloudtrail:DeleteTrail",
      "cloudtrail:UpdateTrail",
      "s3:PutAccountPublicAccessBlock",
      "securityhub:DisableSecurityHub",
      "backup:DeleteBackupVaultLockConfiguration",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DenyRegionsOutsideAllowList"
    effect = "Deny"
    not_actions = [
      "a4b:*", "access-analyzer:*", "account:*", "acm:*", "aws-marketplace:*", "aws-portal:*",
      "budgets:*", "ce:*", "cloudfront:*", "cur:*", "globalaccelerator:*", "health:*", "iam:*",
      "kms:*", "organizations:*", "pricing:*", "route53:*", "route53domains:*", "s3:GetAccountPublicAccessBlock",
      "s3:ListAllMyBuckets", "shield:*", "sso:*", "sts:*", "support:*", "tag:*", "trustedadvisor:*",
      "waf:*", "wafv2:*",
    ]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = var.allowed_regions
    }
  }
}

resource "aws_organizations_policy" "guardrails" {
  name        = "kesher-guardrails"
  description = "Region allow-list, audit-trail protection, no leaving the Organization"
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.scp.json
}

resource "aws_organizations_policy_attachment" "guardrails" {
  policy_id = aws_organizations_policy.guardrails.id
  target_id = aws_organizations_organization.this.roots[0].id
}

# ---- account-wide S3 guard and log bucket ------------------------------------------------------

resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

module "logs_bucket" {
  source = "../../modules/log-bucket"
  name   = "kesher-shared-logs-${var.shared_account_id}"
}

# ---- KMS ---------------------------------------------------------------------------------------

module "kms_ecr" {
  source      = "../../modules/kms"
  name        = "kesher-shared-ecr"
  description = "Container images in ECR"
}

module "kms_audit" {
  source             = "../../modules/kms"
  name               = "kesher-shared-audit"
  description        = "Organization CloudTrail logs in S3 and CloudWatch"
  service_principals = ["cloudtrail.amazonaws.com", "logs.${var.region}.amazonaws.com"]
}

module "kms_backup" {
  source            = "../../modules/kms"
  name              = "kesher-shared-backup"
  description       = "Cross-account backup copies in the locked vault"
  cross_account_ids = local.member_ids
}

# ---- ECR ---------------------------------------------------------------------------------------

resource "aws_ecr_repository" "this" {
  for_each = toset(var.ecr_repositories)

  name                 = "kesher/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.kms_ecr.key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire preview images after 14 days"
        selection    = { tagStatus = "tagged", tagPrefixList = ["pr-"], countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 50 release images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
        action       = { type = "expire" }
      },
    ]
  })
}

data "aws_iam_policy_document" "ecr_pull" {
  statement {
    sid     = "MemberAccountsPull"
    actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    principals {
      type        = "AWS"
      identifiers = [for id in local.member_ids : "arn:${data.aws_partition.current.partition}:iam::${id}:root"]
    }
  }
}

resource "aws_ecr_repository_policy" "pull" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy     = data.aws_iam_policy_document.ecr_pull.json
}

# ---- Route 53 ----------------------------------------------------------------------------------

resource "aws_route53_zone" "root" {
  name    = var.root_domain
  comment = "Kesher Club public zone; records are written by env roots through the CI role"
}

resource "aws_route53_query_log" "root" {
  zone_id                  = aws_route53_zone.root.zone_id
  cloudwatch_log_group_arn = aws_cloudwatch_log_group.dns.arn
  depends_on               = [aws_cloudwatch_log_resource_policy.dns]
}

resource "aws_cloudwatch_log_group" "dns" {
  name              = "/aws/route53/${var.root_domain}"
  retention_in_days = 90
  kms_key_id        = module.kms_audit.key_arn
}

data "aws_iam_policy_document" "dns_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.dns.arn}:*"]
    principals {
      type        = "Service"
      identifiers = ["route53.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_resource_policy" "dns" {
  policy_name     = "route53-query-logging"
  policy_document = data.aws_iam_policy_document.dns_logs.json
}

# ---- CI role (GitHub OIDC) ---------------------------------------------------------------------

data "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
}

data "aws_dynamodb_table" "lock" {
  name = var.lock_table_name
}

data "aws_kms_alias" "state" {
  name = "alias/kesher-terraform-state"
}

module "oidc" {
  source               = "../../modules/oidc"
  github_repository    = var.github_repository
  ecr_repository_arns  = [for r in aws_ecr_repository.this : r.arn]
  assumable_role_arns  = values(local.deploy_role_arns)
  hosted_zone_arns     = [aws_route53_zone.root.arn]
  state_bucket_arn     = data.aws_s3_bucket.state.arn
  state_lock_table_arn = data.aws_dynamodb_table.lock.arn
  state_kms_key_arn    = data.aws_kms_alias.state.target_key_arn
}

# ---- Organization CloudTrail -------------------------------------------------------------------

resource "aws_s3_bucket" "cloudtrail" {
  bucket = "kesher-org-cloudtrail-${var.shared_account_id}"
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = module.kms_audit.key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_logging" "cloudtrail" {
  bucket        = aws_s3_bucket.cloudtrail.id
  target_bucket = module.logs_bucket.bucket_name
  target_prefix = "s3/cloudtrail/"
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    id     = "retain-seven-years"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 2557
    }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid       = "AWSCloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:${var.region}:${var.shared_account_id}:trail/kesher-org"]
    }
  }

  statement {
    sid     = "AWSCloudTrailWrite"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${var.shared_account_id}/*",
      "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${aws_organizations_organization.this.id}/*",
    ]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:${var.region}:${var.shared_account_id}:trail/kesher-org"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.cloudtrail.arn, "${aws_s3_bucket.cloudtrail.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/kesher/org-cloudtrail"
  retention_in_days = 365
  kms_key_id        = module.kms_audit.key_arn
}

data "aws_iam_policy_document" "cloudtrail_logs_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

# CloudTrail creates one log stream per account in the Organization under this group.
data "aws_iam_policy_document" "cloudtrail_logs" {
  #tfsec:ignore:aws-iam-no-policy-wildcards
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:*"]
  }
}

resource "aws_iam_role" "cloudtrail_logs" {
  name               = "kesher-org-cloudtrail-logs"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_logs_trust.json
}

resource "aws_iam_role_policy" "cloudtrail_logs" {
  name   = "write-logs"
  role   = aws_iam_role.cloudtrail_logs.id
  policy = data.aws_iam_policy_document.cloudtrail_logs.json
}

resource "aws_cloudtrail" "org" {
  name                          = "kesher-org"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  kms_key_id                    = module.kms_audit.key_arn
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail_logs.arn

  depends_on = [aws_s3_bucket_policy.cloudtrail, aws_organizations_organization.this]
}

# ---- Security Hub ------------------------------------------------------------------------------

resource "aws_securityhub_account" "this" {
  enable_default_standards  = false
  control_finding_generator = "SECURITY_CONTROL"
}

resource "aws_securityhub_organization_admin_account" "this" {
  admin_account_id = var.shared_account_id
  depends_on       = [aws_securityhub_account.this, aws_organizations_organization.this]
}

resource "aws_securityhub_organization_configuration" "this" {
  auto_enable = true
  depends_on  = [aws_securityhub_organization_admin_account.this]
}

resource "aws_securityhub_standards_subscription" "fsbp" {
  standards_arn = "arn:${data.aws_partition.current.partition}:securityhub:${var.region}::standards/aws-foundational-security-best-practices/v/1.0.0"
  depends_on    = [aws_securityhub_account.this]
}

# ---- Locked backup vault (DR destination) ------------------------------------------------------

resource "aws_backup_vault" "locked" {
  name        = "kesher-locked"
  kms_key_arn = module.kms_backup.key_arn
}

resource "aws_backup_vault_lock_configuration" "locked" {
  backup_vault_name   = aws_backup_vault.locked.name
  changeable_for_days = 3
  min_retention_days  = 35
  max_retention_days  = 400
}

data "aws_iam_policy_document" "vault" {
  statement {
    sid       = "MemberAccountsCopyIn"
    actions   = ["backup:CopyIntoBackupVault"]
    resources = [aws_backup_vault.locked.arn]
    principals {
      type        = "AWS"
      identifiers = [for id in local.member_ids : "arn:${data.aws_partition.current.partition}:iam::${id}:root"]
    }
  }
}

resource "aws_backup_vault_policy" "locked" {
  backup_vault_name = aws_backup_vault.locked.name
  policy            = data.aws_iam_policy_document.vault.json
}

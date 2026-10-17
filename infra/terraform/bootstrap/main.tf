# Run once, from club-shared, with local state: creates the Terraform state bucket, its CMK and
# the DynamoDB lock table that every other root's S3 backend uses. See ../README.md.

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.shared_account_id]
  default_tags {
    tags = {
      Project   = "kesher-club"
      ManagedBy = "terraform"
      Root      = "bootstrap"
    }
  }
}

module "state_key" {
  source      = "../modules/kms"
  name        = "kesher-terraform-state"
  description = "Terraform state bucket and lock table"
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = module.state_key.key_arn
    }
    bucket_key_enabled = true
  }
}

module "access_logs" {
  source = "../modules/log-bucket"
  name   = "${var.state_bucket_name}-access-logs"
}

resource "aws_s3_bucket_logging" "state" {
  bucket        = aws_s3_bucket.state.id
  target_bucket = module.access_logs.bucket_name
  target_prefix = "s3/${var.state_bucket_name}/"
}

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json
}

resource "aws_dynamodb_table" "lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = module.state_key.key_arn
  }
}

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Partial configuration: bucket, key, region, dynamodb_table and kms_key_id come from
  # backend.hcl (terraform init -backend-config=backend.hcl).
  backend "s3" {}
}

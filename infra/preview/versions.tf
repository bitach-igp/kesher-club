terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }

  # Partial configuration: backend.hcl plus `-backend-config="key=preview/pr-<n>.tfstate"`
  # passed by .github/workflows/preview.yml so each PR has its own state.
  backend "s3" {}
}

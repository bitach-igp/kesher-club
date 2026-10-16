# This file exists so `terraform test` can run from infra/terraform against tests/*.tftest.hcl,
# which exercise the modules directly. It is not a deployable root; the roots are envs/*.
terraform {
  required_version = ">= 1.7"
}

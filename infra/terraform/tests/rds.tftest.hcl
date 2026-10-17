# Plan-mode checks for modules/rds against a mocked AWS provider.

mock_provider "aws" {
  # Policy documents are validated as JSON at plan time, so the mock must return real JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name        = "kesher-test"
  vpc_id      = "vpc-00000000000000000"
  subnet_ids  = ["subnet-0000000000000000a", "subnet-0000000000000000b", "subnet-0000000000000000c"]
  kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
}

run "prod_defaults" {
  command = plan

  module {
    source = "./modules/rds"
  }

  assert {
    condition     = aws_db_instance.this.storage_encrypted == true && aws_db_instance.this.kms_key_id == var.kms_key_arn
    error_message = "storage must be encrypted with the environment CMK"
  }

  assert {
    condition     = aws_db_instance.this.multi_az == true
    error_message = "primary must be Multi-AZ"
  }

  assert {
    condition     = aws_db_instance.this.backup_retention_period == 35
    error_message = "PITR window must be 35 days"
  }

  assert {
    condition     = aws_db_instance.this.publicly_accessible == false
    error_message = "the database must never be publicly accessible"
  }

  assert {
    condition     = aws_db_instance.this.engine == "postgres" && startswith(aws_db_instance.this.engine_version, "16")
    error_message = "engine must be Postgres 16"
  }

  assert {
    condition     = aws_db_instance.this.instance_class == "db.r7g.large" && aws_db_instance.this.storage_type == "gp3" && aws_db_instance.this.allocated_storage == 200
    error_message = "pilot sizing is db.r7g.large, gp3, 200 GB"
  }

  assert {
    condition     = aws_db_instance.this.manage_master_user_password == true && aws_db_instance.this.password == null
    error_message = "the master password must be managed by RDS in Secrets Manager, never set in Terraform"
  }

  assert {
    condition     = aws_db_instance.this.deletion_protection == true && aws_db_instance.this.skip_final_snapshot == false
    error_message = "prod defaults keep deletion protection and a final snapshot"
  }

  assert {
    condition     = aws_db_instance.this.performance_insights_enabled == true && aws_db_instance.this.performance_insights_kms_key_id == var.kms_key_arn
    error_message = "Performance Insights must be on and CMK-encrypted"
  }

  assert {
    condition     = length(aws_db_instance.replica) == 1 && aws_db_instance.replica[0].publicly_accessible == false && aws_db_instance.replica[0].storage_encrypted == true
    error_message = "a private, encrypted read replica is part of the prod layout"
  }

  assert {
    condition     = one([for p in aws_db_parameter_group.this.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "TLS must be forced at the parameter-group level"
  }
}

run "security_group_only_from_listed_groups" {
  command = plan

  module {
    source = "./modules/rds"
  }

  variables {
    allowed_security_group_ids = ["sg-0000000000000000a", "sg-0000000000000000b"]
    create_read_replica        = false
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.apps) == 2
    error_message = "one 5432 rule per allowed security group"
  }

  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.apps : r.from_port == 5432 && r.to_port == 5432 && r.cidr_ipv4 == null])
    error_message = "ingress must be security-group based, never CIDR based"
  }

  assert {
    condition     = length(aws_db_instance.replica) == 0
    error_message = "replica is optional"
  }
}

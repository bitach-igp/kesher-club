# Plan-mode checks for modules/network against a mocked AWS provider (no credentials needed).

mock_provider "aws" {
  # Policy documents are validated as JSON at plan time, so the mock must return real JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name            = "kesher-test"
  cidr            = "10.0.0.0/16"
  log_kms_key_arn = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
}

run "three_az_layout" {
  command = plan

  module {
    source = "./modules/network"
  }

  assert {
    condition     = length(aws_subnet.private) == 3
    error_message = "expected one private (app) subnet per AZ"
  }

  assert {
    condition     = length(aws_subnet.database) == 3
    error_message = "expected one isolated database subnet per AZ"
  }

  assert {
    condition     = length(aws_subnet.public) == 3
    error_message = "expected one public subnet per AZ"
  }

  assert {
    condition     = length(distinct(concat(aws_subnet.public[*].cidr_block, aws_subnet.private[*].cidr_block, aws_subnet.database[*].cidr_block))) == 9
    error_message = "subnet CIDRs must not overlap"
  }

  assert {
    condition     = alltrue([for s in concat(aws_subnet.public, aws_subnet.private, aws_subnet.database) : s.map_public_ip_on_launch == false])
    error_message = "no subnet may auto-assign public IPs"
  }
}

run "database_tier_has_no_internet_route" {
  command = plan

  module {
    source = "./modules/network"
  }

  # The database route table gets no aws_route at all: only the public (IGW) and private (NAT)
  # tables carry a default route.
  assert {
    condition     = length(aws_route.private_nat) == 3 && aws_route.public_internet.destination_cidr_block == "0.0.0.0/0"
    error_message = "only public and private route tables carry default routes"
  }

  assert {
    condition     = length(aws_route_table_association.database) == 3
    error_message = "every database subnet must be bound to the isolated route table"
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 3
    error_message = "prod layout is one NAT gateway per AZ"
  }
}

run "single_nat_for_staging" {
  command = plan

  module {
    source = "./modules/network"
  }

  variables {
    single_nat_gateway = true
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 1
    error_message = "single_nat_gateway should collapse NAT to one gateway"
  }
}

run "endpoints_and_flow_logs" {
  command = plan

  module {
    source = "./modules/network"
  }

  assert {
    condition     = toset(keys(aws_vpc_endpoint.interface)) == toset(["secretsmanager", "kms", "ecr.api", "ecr.dkr", "logs"])
    error_message = "interface endpoints for Secrets Manager, KMS, ECR and Logs are required"
  }

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway"
    error_message = "S3 must use a gateway endpoint"
  }

  assert {
    condition     = aws_flow_log.this.traffic_type == "ALL" && aws_cloudwatch_log_group.flow.kms_key_id == var.log_kms_key_arn
    error_message = "flow logs must capture all traffic into a CMK-encrypted log group"
  }

  assert {
    condition     = length(aws_ec2_client_vpn_endpoint.this) == 0
    error_message = "Client VPN is off unless configured"
  }
}

# T-0914: Client VPN source-NATs to its interface in the associated subnet, so it gets subnets of its own
# and the admin console's IP gate can tell VPN traffic from the ECS tasks in the app subnets. Applied
# against the mocks (nothing reaches AWS) so the association's subnet ids are known to compare.
run "client_vpn_has_its_own_subnets" {
  command = apply

  module {
    source = "./modules/network"
  }

  # A mocked apply invents ARNs as random strings; the flow log validates the two it is given.
  override_resource {
    target = aws_cloudwatch_log_group.flow
    values = { arn = "arn:aws:logs:us-east-1:111111111111:log-group:/kesher/test/flow" }
  }

  override_resource {
    target = aws_iam_role.flow
    values = { arn = "arn:aws:iam::111111111111:role/kesher-test-flow" }
  }

  variables {
    client_vpn = {
      server_certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
      saml_provider_arn      = "arn:aws:iam::111111111111:saml-provider/kesher-test"
    }
  }

  assert {
    condition     = length(aws_subnet.vpn) == 3 && toset(aws_subnet.vpn[*].availability_zone) == toset(aws_subnet.private[*].availability_zone)
    error_message = "expected one VPN subnet per AZ"
  }

  assert {
    condition     = length(distinct(concat(aws_subnet.public[*].cidr_block, aws_subnet.private[*].cidr_block, aws_subnet.database[*].cidr_block, aws_subnet.vpn[*].cidr_block))) == 12
    error_message = "the VPN subnets must not overlap any other tier"
  }

  assert {
    condition     = toset(aws_ec2_client_vpn_network_association.this[*].subnet_id) == toset(aws_subnet.vpn[*].id)
    error_message = "the VPN must be associated with its own subnets, never the app subnets"
  }

  assert {
    condition     = output.client_vpn_source_cidrs == aws_subnet.vpn[*].cidr_block && length(setintersection(toset(output.client_vpn_source_cidrs), toset(aws_subnet.private[*].cidr_block))) == 0
    error_message = "the console's IP gate must list the VPN subnets and nothing the ECS tasks run in"
  }
}

run "rejects_wrong_az_count" {
  command = plan

  module {
    source = "./modules/network"
  }

  variables {
    availability_zones = ["us-east-1a", "us-east-1b"]
  }

  expect_failures = [var.availability_zones]
}

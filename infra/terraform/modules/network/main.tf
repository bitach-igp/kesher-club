# VPC across three AZs. Public subnets carry only the ALB and NAT gateways; ECS tasks live in the
# private subnets and RDS in the isolated database subnets (no route to the internet at all).
# Interface endpoints keep Secrets Manager, KMS, ECR and CloudWatch Logs traffic inside the VPC.

locals {
  az_count = length(var.availability_zones)
  # /16 split into /20 blocks: 0-2 public, 3-5 private (app), 6-8 database.
  public_cidrs   = [for i in range(local.az_count) : cidrsubnet(var.cidr, 4, i)]
  private_cidrs  = [for i in range(local.az_count) : cidrsubnet(var.cidr, 4, i + 3)]
  database_cidrs = [for i in range(local.az_count) : cidrsubnet(var.cidr, 4, i + 6)]
  nat_count      = var.single_nat_gateway ? 1 : local.az_count
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = var.name })
}

# The default security group is left with no rules so nothing can accidentally use it.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-default-unused" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = var.name })
}

# ---- subnets -----------------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = local.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-public-${var.availability_zones[count.index]}", Tier = "public" })
}

resource "aws_subnet" "private" {
  count = local.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.private_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-private-${var.availability_zones[count.index]}", Tier = "private" })
}

resource "aws_subnet" "database" {
  count = local.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.database_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-database-${var.availability_zones[count.index]}", Tier = "database" })
}

# ---- NAT and routing ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  count = local.nat_count

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(var.tags, { Name = "${var.name}-nat-${var.availability_zones[count.index]}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = local.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count = local.az_count

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-private-${var.availability_zones[count.index]}" })
}

resource "aws_route" "private_nat" {
  count = local.az_count

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = local.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Database subnets share one route table with no default route: they are unreachable from and
# cannot reach the internet.
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-database" })
}

resource "aws_route_table_association" "database" {
  count = local.az_count

  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}

# ---- VPC endpoints -----------------------------------------------------------------------------

data "aws_region" "current" {}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.database.id])
  tags              = merge(var.tags, { Name = "${var.name}-s3" })
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-vpc-endpoints"
  description = "HTTPS from inside the VPC to interface endpoints"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name}-vpc-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  description       = "HTTPS from the VPC"
  cidr_ipv4         = aws_vpc.this.cidr_block
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoints)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(var.tags, { Name = "${var.name}-${each.key}" })
}

# ---- flow logs ---------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/kesher/${var.name}/vpc-flow-logs"
  retention_in_days = var.flow_log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "flow_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

# Log streams are created per ENI with generated names, so the stream wildcard under the one log
# group is the narrowest resource CloudWatch Logs accepts for PutLogEvents.
data "aws_iam_policy_document" "flow" {
  #tfsec:ignore:aws-iam-no-policy-wildcards
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_iam_role" "flow" {
  name               = "${var.name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "flow" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow.json
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow.arn
  iam_role_arn    = aws_iam_role.flow.arn
  tags            = merge(var.tags, { Name = var.name })
}

# ---- Client VPN (admin access, federated through Identity Center) -----------------------------

resource "aws_cloudwatch_log_group" "vpn" {
  count = var.client_vpn == null ? 0 : 1

  name              = "/kesher/${var.name}/client-vpn"
  retention_in_days = var.flow_log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_stream" "vpn" {
  count = var.client_vpn == null ? 0 : 1

  name           = "connections"
  log_group_name = aws_cloudwatch_log_group.vpn[0].name
}

resource "aws_security_group" "vpn" {
  count = var.client_vpn == null ? 0 : 1

  name        = "${var.name}-client-vpn"
  description = "Client VPN ENIs: all traffic out to the VPC"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name}-client-vpn" })
}

resource "aws_vpc_security_group_egress_rule" "vpn" {
  count = var.client_vpn == null ? 0 : 1

  security_group_id = aws_security_group.vpn[0].id
  description       = "VPN clients to the VPC"
  cidr_ipv4         = aws_vpc.this.cidr_block
  ip_protocol       = "-1"
}

resource "aws_ec2_client_vpn_endpoint" "this" {
  count = var.client_vpn == null ? 0 : 1

  description            = "${var.name} admin access"
  server_certificate_arn = var.client_vpn.server_certificate_arn
  client_cidr_block      = var.client_vpn.client_cidr
  split_tunnel           = true
  vpc_id                 = aws_vpc.this.id
  security_group_ids     = [aws_security_group.vpn[0].id]
  transport_protocol     = "udp"
  session_timeout_hours  = 8

  authentication_options {
    type              = "federated-authentication"
    saml_provider_arn = var.client_vpn.saml_provider_arn
  }

  connection_log_options {
    enabled               = true
    cloudwatch_log_group  = aws_cloudwatch_log_group.vpn[0].name
    cloudwatch_log_stream = aws_cloudwatch_log_stream.vpn[0].name
  }

  tags = merge(var.tags, { Name = "${var.name}-client-vpn" })
}

resource "aws_ec2_client_vpn_network_association" "this" {
  count = var.client_vpn == null ? 0 : local.az_count

  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.this[0].id
  subnet_id              = aws_subnet.private[count.index].id
}

resource "aws_ec2_client_vpn_authorization_rule" "vpc" {
  count = var.client_vpn == null ? 0 : 1

  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.this[0].id
  target_network_cidr    = aws_vpc.this.cidr_block
  access_group_id        = var.client_vpn.access_group_id
  authorize_all_groups   = var.client_vpn.access_group_id == null
  description            = "Admin group reaches the VPC"
}

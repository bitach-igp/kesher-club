output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "database_subnet_ids" {
  value = aws_subnet.database[*].id
}

output "private_route_table_ids" {
  value = aws_route_table.private[*].id
}

output "vpc_endpoints_security_group_id" {
  value = aws_security_group.endpoints.id
}

output "client_vpn_endpoint_id" {
  value = var.client_vpn == null ? null : aws_ec2_client_vpn_endpoint.this[0].id
}

output "client_vpn_source_cidrs" {
  description = "Where Client VPN traffic comes from inside the VPC: its own subnets, after source NAT. Empty without a VPN."
  value       = aws_subnet.vpn[*].cidr_block
}

# Mail authentication and certificate-issuance records for the public zone (T-0057). Without SPF, DKIM and DMARC the OTP and
# receipt e-mail (Postmark) lands in spam; CAA limits who can issue a certificate for the domain.

locals {
  spf = "v=spf1 ${join(" ", [for h in var.spf_includes : "include:${h}"])} ~all"
  rua = "mailto:${var.dmarc_report_address}"
}

resource "aws_route53_record" "spf" {
  zone_id = var.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 300
  records = [local.spf]
}

resource "aws_route53_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=${var.dmarc_policy}; rua=${local.rua}; adkim=s; aspf=s; fo=1"]
}

resource "aws_route53_record" "dkim" {
  count = var.dkim == null ? 0 : 1

  zone_id = var.zone_id
  name    = "${var.dkim.selector}._domainkey.${var.domain}"
  type    = "TXT"
  ttl     = 300
  records = [var.dkim.value]
}

resource "aws_route53_record" "return_path" {
  count = var.return_path_target == null ? 0 : 1

  zone_id = var.zone_id
  name    = "pm-bounces.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = [var.return_path_target]
}

resource "aws_route53_record" "caa" {
  zone_id = var.zone_id
  name    = var.domain
  type    = "CAA"
  ttl     = 300
  records = concat(
    [for ca in var.caa_issuers : "0 issue \"${ca}\""],
    [for ca in var.caa_issuers : "0 issuewild \"${ca}\""],
    var.caa_report_address == null ? [] : ["0 iodef \"mailto:${var.caa_report_address}\""],
  )
}

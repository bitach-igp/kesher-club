# Plan-mode checks for modules/mail-records (T-0057): SPF, DMARC, DKIM, return path and CAA.

mock_provider "aws" {}

variables {
  zone_id              = "Z00000000000000000000"
  domain               = "kesher.club"
  dmarc_report_address = "dmarc@kesher.club"
}

run "defaults_start_dmarc_at_none" {
  command = plan

  module {
    source = "./modules/mail-records"
  }

  assert {
    condition     = one(aws_route53_record.spf.records) == "v=spf1 include:spf.mtasv.net ~all"
    error_message = "SPF includes Postmark and soft-fails everything else"
  }

  assert {
    condition     = startswith(one(aws_route53_record.dmarc.records), "v=DMARC1; p=none; rua=mailto:dmarc@kesher.club;") && aws_route53_record.dmarc.name == "_dmarc.kesher.club"
    error_message = "DMARC starts at p=none with an aggregate report address"
  }

  assert {
    condition     = length(aws_route53_record.dkim) == 0
    error_message = "DKIM is written only when the Postmark selector and key are supplied"
  }

  assert {
    condition     = one(aws_route53_record.return_path).name == "pm-bounces.kesher.club" && one(one(aws_route53_record.return_path).records) == "pm.mtasv.net"
    error_message = "the Postmark return path is a CNAME"
  }

  assert {
    condition     = toset(aws_route53_record.caa.records) == toset(["0 issue \"amazon.com\"", "0 issue \"amazontrust.com\"", "0 issuewild \"amazon.com\"", "0 issuewild \"amazontrust.com\""])
    error_message = "CAA allows only Amazon's certificate authorities"
  }
}

run "dkim_and_stricter_policy" {
  command = plan

  module {
    source = "./modules/mail-records"
  }

  variables {
    dkim               = { selector = "20260101pm", value = "k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ" }
    dmarc_policy       = "quarantine"
    caa_report_address = "security@kesher.club"
  }

  assert {
    condition     = one(aws_route53_record.dkim).name == "20260101pm._domainkey.kesher.club"
    error_message = "the DKIM record sits under the selector"
  }

  assert {
    condition     = strcontains(one(aws_route53_record.dmarc.records), "p=quarantine")
    error_message = "the policy follows the variable"
  }

  assert {
    condition     = contains(aws_route53_record.caa.records, "0 iodef \"mailto:security@kesher.club\"")
    error_message = "CAA violations are reported when an address is given"
  }
}

run "refuses_a_bad_policy_and_a_bad_report_address" {
  command = plan

  module {
    source = "./modules/mail-records"
  }

  variables {
    dmarc_policy         = "off"
    dmarc_report_address = "not-an-address"
  }

  expect_failures = [var.dmarc_policy, var.dmarc_report_address]
}

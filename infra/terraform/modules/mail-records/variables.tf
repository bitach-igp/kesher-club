variable "zone_id" {
  description = "The public hosted zone the records are written to."
  type        = string
}

variable "domain" {
  description = "The zone's domain, e.g. kesher.club."
  type        = string
}

variable "spf_includes" {
  description = "Hostnames the apex SPF record includes: the senders allowed to send as the domain. Postmark publishes spf.mtasv.net."
  type        = list(string)
  default     = ["spf.mtasv.net"]
}

variable "dkim" {
  description = "Postmark DKIM: the selector (the label before ._domainkey) and the public-key TXT value, both from the Postmark sender signature page. Null until the sender is created there."
  type = object({
    selector = string
    value    = string
  })
  default = null
}

variable "return_path_target" {
  description = "Where the bounce (return path) CNAME points. Postmark publishes pm.mtasv.net. Null leaves the return path unset."
  type        = string
  default     = "pm.mtasv.net"
}

variable "dmarc_policy" {
  description = "none while senders are verified; quarantine after two clean weeks of reports; reject once no legitimate mail fails."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_report_address" {
  description = "Mailbox that receives DMARC aggregate reports. No default: someone must own it."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.dmarc_report_address))
    error_message = "dmarc_report_address must be an e-mail address."
  }
}

variable "caa_issuers" {
  description = "Certificate authorities allowed to issue for the domain. ACM uses amazon.com and amazontrust.com."
  type        = list(string)
  default     = ["amazon.com", "amazontrust.com"]
}

variable "caa_report_address" {
  description = "Optional mailbox CAA violations are reported to."
  type        = string
  default     = null
}

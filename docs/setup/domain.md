# Domain and mail records (T-0057)

The public zone lives in club-shared (`envs/shared`). Everything under it (the API hosts, `app.`, `console.`, `admin.`, `vpn.`)
is written by the environment roots; the mail and certificate records below are written by the shared root.

## Order

1. **Choose and buy the domain.** Nothing in Terraform can do this. Until you pass it, `envs/shared` refuses the
   `kesher.example` placeholder (and the `.example` root e-mails of the member accounts).
2. **Apply `envs/shared`** with `-var root_domain=<domain>`, `-var dmarc_report_address=<mailbox>` (see `docs/setup/release.md` step 3).
   It creates the zone and, in it: an SPF record that allows Postmark (`include:spf.mtasv.net`), a DMARC record at `p=none` with
   aggregate reports to your mailbox, the Postmark return-path CNAME (`pm-bounces.<domain>` to `pm.mtasv.net`), and CAA records that
   allow only Amazon's certificate authorities (`amazon.com`, `amazontrust.com`; ACM issues the certificates).
3. **Delegate** the domain to the zone's name servers (`terraform output hosted_zone_name_servers`) at the registrar. Nothing resolves
   until you do.
4. **Create the sender in Postmark** for the domain. Postmark shows a DKIM selector and a public-key TXT value: apply `envs/shared`
   again with `-var 'postmark_dkim={selector="<selector>",value="<value>"}'` and verify the sender in Postmark.
5. **Raise DMARC** to `quarantine` (`-var dmarc_policy=quarantine`) after two clean weeks of aggregate reports, and to `reject` once no
   legitimate mail fails. Read the reports before each step.

## What each record does

| Record | Purpose |
|---|---|
| SPF (apex TXT) | names who may send as the domain; everything else soft-fails |
| DKIM (`<selector>._domainkey`) | Postmark signs outgoing mail; receivers check the signature |
| DMARC (`_dmarc`) | tells receivers what to do when SPF and DKIM both fail, and where to report |
| Return path (`pm-bounces`) | bounces come back to Postmark; DMARC alignment is relaxed because this is a subdomain of the From domain |
| CAA (apex) | only the listed authorities may issue certificates for the domain and its subdomains |

A DKIM key longer than 255 characters (a 2048-bit key) is split into quoted strings automatically. Until step 4 is done, mail sent through Postmark fails DMARC (harmless at `p=none`; do not raise the policy before the sender is verified).
The apex A record for the web site belongs with the prod web module (`app.<domain>` is already written there); this change adds no web record.
Records for a second sender (a support desk, a newsletter) are added by extending `spf_includes` in `modules/mail-records` through a card.

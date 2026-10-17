-- T-0908 complaints and alert dispositions (REQ-CMP-002, REQ-CMP-001)
-- Complaints live in ops: a complaint is a record about a person, never a money row. The summary is
-- member text and is rendered, never interpreted. Staff who act are stamped by their SSO subject, the
-- same string the audit chain carries, so the bank's export and the audit trail name the same person.
create table ops.complaint (
  id                 uuid primary key,
  party_id           uuid not null,
  channel            text not null check (channel in ('app','email','phone','bank','regulator')),
  category           text not null,
  summary            text not null,                 -- member text: untrusted
  status             text not null default 'open' check (status in ('open','acknowledged','resolved','withdrawn')),
  opened_at          timestamptz not null,          -- both SLA clocks start here
  logged_by          text not null,                 -- staff subject, or 'member' when the app files it
  acknowledged_at    timestamptz,
  acknowledged_by    text,
  resolved_at        timestamptz,
  resolved_by        text,
  owner              text,
  escalated_to_bank  boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on ops.complaint (status, opened_at);
create index on ops.complaint (party_id);

-- Monitoring alerts are ops.case rows of the monitoring kinds (structuring, velocity, sanctions_hit,
-- kyc_manual_review, recon_break). A disposition is the compliance decision on one: in_review keeps
-- it open, cleared resolves it, escalated hands it to the bank and closes it for the console.
alter table ops.case add column disposition text;
alter table ops.case add column decided_by text;
alter table ops.case add column decided_at timestamptz;
alter table ops.case add column decision_note text;
-- NOT VALID still checks every new and updated row; it only skips the scan of existing rows, and
-- ops.case has none that carry a disposition. Validating in the same transaction would take the lock
-- Squawk warns about for nothing.
alter table ops.case add constraint case_disposition_check check (disposition in ('in_review','cleared','escalated')) not valid;

grant select, insert, update on ops.complaint to club_app;

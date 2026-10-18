-- T-0514 receiving currency preference (REQ-PAY-007)
-- One row per member who set a preference: which purse money sent to them lands in. No row means
-- "as sent", the default (ADR-007). Nothing here is personal data beyond the party id.
create table identity.member_preference (
  party_id          uuid primary key,
  receive_currency  text not null check (receive_currency in ('USD','ILS','as_sent')),
  updated_at        timestamptz not null default now()
);

grant select, insert, update on identity.member_preference to club_app;

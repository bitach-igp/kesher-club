-- T-0531 the name others see when paying a member (REQ-PAY-008)
-- What a member typed once: the first name and the last name's initial, nothing more of the last name, so a
-- payer sees "Avi E." and a stranger learns no surname. Both are personal data (class P1, constitution art. 9):
-- bytea written by the app's PII cipher under each column's name, never plaintext. One row per member,
-- replaced when they change it; no index on either, since nothing looks a member up by name.
create table identity.member_display_name (
  party_id      uuid primary key,
  first_name    bytea not null,
  last_initial  bytea,
  updated_at    timestamptz not null
);

grant select, insert, update on identity.member_display_name to club_app;

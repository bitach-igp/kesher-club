-- T-0789 staff IdP link (REQ-AUTH-008): maps an institution's IdP subject to a staff party, so a directory event can find who to
-- deprovision. The IdP's own id is the key; an email address never is. A new, empty table, so every constraint is valid at once.
-- One subject maps to one party in an institution, and one party holds at most one live link, so a party cannot be linked to two
-- institutions. The table is insert-only: club_app has no delete, and may update `unlinked_at` and nothing else, so who a
-- subject points to cannot be rewritten; a re-link is a new row and the old one stays as history. The staff check (active staff of
-- that institution) is made by the store, because org.staff changes after a link is written.
create table org.staff_idp_link (
  id              uuid primary key,
  institution_id  uuid not null references org.institution(id),
  idp_subject     text not null check (length(idp_subject) between 1 and 255),
  party_id        uuid not null,
  linked_at       timestamptz not null,
  unlinked_at     timestamptz,
  check (unlinked_at is null or unlinked_at >= linked_at)
);
create unique index staff_idp_link_live_subject on org.staff_idp_link (institution_id, idp_subject) where unlinked_at is null;
create unique index staff_idp_link_live_party on org.staff_idp_link (party_id) where unlinked_at is null;
create index on org.staff_idp_link (institution_id);

-- A column grant cannot say "once": without this trigger club_app could set unlinked_at back to null and revive a link.
create function org.staff_idp_link_unlink_once() returns trigger language plpgsql as $$
begin
  if old.unlinked_at is not null then
    raise exception 'staff_idp_link % is already unlinked', old.id using errcode = '23514';
  end if;
  return new;
end $$;
create trigger staff_idp_link_unlink_once before update on org.staff_idp_link for each row execute function org.staff_idp_link_unlink_once();

grant select, insert on org.staff_idp_link to club_app;
grant update (unlinked_at) on org.staff_idp_link to club_app;

-- T-0787 ops.workflow_marker delete for failed-owner markers only (enabling): the owner decided "allow delete grant" (T-0763's open question), so a
-- failed-owner marker (kind `subaccount_owner:{provider}`) can be cleared once staff have fixed the owner. The credit, lost-key, payee and purpose
-- markers stay write-once, so the grant is table-wide (Postgres has no row-level grant) but a BEFORE DELETE row trigger refuses every other kind,
-- for every role including the owner. No update and no truncate is granted. The message names no kind, subject or value.
-- Tests and desktop steps that clean up as a superuser use `set local session_replication_role = replica` inside a transaction (triggers do not fire).
create function ops.workflow_marker_delete_guard() returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if left(old.kind, 17) <> 'subaccount_owner:' then
    raise exception 'ops.workflow_marker: only a failed-owner marker may be deleted';
  end if;
  return old;
end $$;
create trigger workflow_marker_delete_guard before delete on ops.workflow_marker for each row execute function ops.workflow_marker_delete_guard();
grant delete on ops.workflow_marker to club_app;

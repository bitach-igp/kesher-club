-- Run once per database as a superuser before migrations.
do $$ begin
  if not exists (select from pg_roles where rolname = 'club_app') then create role club_app login; end if;
  if not exists (select from pg_roles where rolname = 'club_migrator') then create role club_migrator login; end if;
end $$;

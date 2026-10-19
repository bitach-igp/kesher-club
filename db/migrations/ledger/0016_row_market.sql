-- T-0027 rows record the market whose API created them (enabling)
-- One API, JIT and worker service runs per market on one shared database (T-0026). Each worker must
-- sweep only its own market's transfers, webhooks and auto-reload rules (T-0028), so every new row
-- carries the market of the API that wrote it: that API's providers handled it. Every row written so far
-- came from the only market any environment has run, IL, and the backfill sets it, so every existing
-- row satisfies the check: it goes on NOT VALID (no scan, no long lock) and binds every write from now
-- on. Not ledger.*: the ledger stays market-free and insert-only.
alter table ops.transfer add column market text;
update ops.transfer set market = 'IL' where market is null;
alter table ops.transfer add constraint transfer_market check (market is not null and market in ('IL', 'US')) not valid;

alter table ops.inbound_event add column market text;
update ops.inbound_event set market = 'IL' where market is null;
alter table ops.inbound_event add constraint inbound_event_market check (market is not null and market in ('IL', 'US')) not valid;

alter table ops.auto_reload add column market text;
update ops.auto_reload set market = 'IL' where market is null;
alter table ops.auto_reload add constraint auto_reload_market check (market is not null and market in ('IL', 'US')) not valid;

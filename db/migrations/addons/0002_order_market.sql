-- T-0027 add-on orders record the market whose API placed them (enabling)
-- The eSIM usage poll (T-0028) asks each market's own provider about that market's orders only. Every
-- order so far came from IL, the only market any environment has run; after the backfill every row
-- satisfies the check, so it goes on NOT VALID, as in ledger/0016.
alter table addons.addon_order add column market text;
update addons.addon_order set market = 'IL' where market is null;
alter table addons.addon_order add constraint addon_order_market check (market is not null and market in ('IL', 'US')) not valid;

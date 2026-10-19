-- T-0023 the worker's record of nightly runs (enabling)
-- One row per job and Israel calendar day, written when a run finishes. A worker that restarts the same
-- day finds the row and does not run the job again; a failed run writes nothing, so the next tick retries
-- it. Insert-only for the service role: a run is never edited or forgotten.
create table ops.job_run (
  job          text not null,
  run_date     date not null,                        -- the Israel calendar day the run belongs to
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  primary key (job, run_date),
  check (finished_at >= started_at)
);

grant select, insert on ops.job_run to club_app;

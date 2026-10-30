-- T-0930 the ops queue (REQ-ADM-005): an ops case can be assigned to a staff member, who then resolves or dismisses
-- it with a note (the decision columns came with ledger/0006). Both new columns are nullable: a case opens
-- unassigned, and existing rows need no value.
alter table ops.case add column assigned_to text;
alter table ops.case add column assigned_at timestamptz;

-- T-0064 (REQ-CRD-003): club_jit can run a card authorisation (owner decision on PR #246, traced in specs/tasks/T-0064.md). The authorisation
-- process (SERVICE_ROLE=jit, T-0063) connects as this role (T-0045), so what it may do is exactly what a decision does and nothing else.
-- It reads accounts and never creates one (T-0413). No DELETE anywhere; no UPDATE of ledger.*; the hold is two INSERTs.
-- The other schemas' grants are in their own directories (billing 0006, audit 0002), because Atlas applies each directory in order.
grant usage on schema ledger, ops, agent to club_jit;
grant select on ledger.account to club_jit;
grant select, insert on ledger.journal, ledger.posting to club_jit;
-- ledger.posting.id is generated always as identity: the INSERT takes the next value from this sequence.
grant usage on sequence ledger.posting_id_seq to club_jit;
-- The balance cache the posting maintains under the per-wallet lock (T-0544): read, insert the first row, update the rest.
grant select, insert, update on ops.account_balance to club_jit;
grant select on ops.fx_rate to club_jit;
-- An agent purchase opens, is consumed and is released on the authorisation path (T-1018).
grant select, insert, update on agent.pending_intent to club_jit;

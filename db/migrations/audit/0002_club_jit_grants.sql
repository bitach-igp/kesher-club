-- T-0064 (REQ-CRD-003): the authorisation reads the flag state (the agentic-purchase kill switch). ops.flag_state is created in this directory, so its
-- grant is here; the ops schema usage is granted in ledger/0028. Read only: a flag changes through the two-person flow, never from this role.
grant select on ops.flag_state to club_jit;

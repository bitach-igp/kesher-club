// The idempotency keys of a money movement's journals. A transfer's workflow id is its idempotency key, and each journal it posts
// is keyed `{workflowId}:{step}`, so a replay finds its own work. One definition: the strings are stored, so they never change.

/** The journal that settles a transfer. */
export const settleKey = (workflowId: string): string => `${workflowId}:settle`;
/** The journal that holds the amount (wallet → pending) before it settles. */
export const holdKey = (workflowId: string): string => `${workflowId}:hold`;
/** The journal that releases a hold (pending → the receiving wallet). */
export const releaseKey = (workflowId: string): string => `${workflowId}:release`;

// The sub-account ref grammar (T-0762, from T-0754). `s:<chapter>` is the sub-account (a chapter under the nonprofit) and
// `s:<chapter>:<account>` its own deposit account. The port owns the grammar: the Crowded adapter and the simulator make the same refs,
// and no caller builds one by hand. Ids become URL path segments, so only `[A-Za-z0-9_-]` passes (1 to 64 characters).
export const subAccountRef = (chapterId: string, accountId?: string): string => (accountId === undefined ? `s:${chapterId}` : `s:${chapterId}:${accountId}`);

export function parseSubAccountRef(r: unknown): { chapterId: string; accountId?: string } | undefined {
  if (typeof r !== 'string') return undefined;
  const m = /^s:([A-Za-z0-9_-]{1,64})(?::([A-Za-z0-9_-]{1,64}))?$/.exec(r);
  return m ? { chapterId: m[1]!, ...(m[2] !== undefined ? { accountId: m[2] } : {}) } : undefined;
}

/** The chapter id inside a sub-account or deposit-account ref, or undefined for any other string. */
export const chapterOf = (r: unknown): string | undefined => parseSubAccountRef(r)?.chapterId;

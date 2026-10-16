// Flags that move money. Kept in step with apps/api/src/flags/service.ts (MONEY_FLAG); the admin
// does not import the API package, so the pattern is restated here with the same test fixture.
export const MONEY_FLAG = /^(wallet\.|card\.|p2p\.|fx\.|payouts\.|funding\.|institutions\.money|mcp\.money)/;
export const isMoneyFlag = (key: string): boolean => MONEY_FLAG.test(key);

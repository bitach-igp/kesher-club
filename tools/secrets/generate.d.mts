export function kids(env: string): { jwt: string; admin: string };
export function key32(): string;
export function password(): string;
export function es256PrivateJwk(kid: string): Record<string, string>;
export function publicJwks(privateJwk: Record<string, string>): { keys: Record<string, string>[] };
export function generateAll(env: string): Record<string, string>;
export const GENERATED: string[];

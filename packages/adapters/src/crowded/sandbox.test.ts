// Crowded sandbox smoke test (T-0648): runs only when CROWDED_SANDBOX_TOKEN is set, otherwise it is skipped. It is
// read-only: it lists organizations to prove the token and the base URL work. The full contract suite cannot run
// against the sandbox unattended, because approving a bank application needs a person (T-0655, questions 9 and 15).
import { describe, expect, it } from 'vitest';
import { CrowdedClient, SANDBOX_BASE_URL } from './client.ts';

const token = process.env['CROWDED_SANDBOX_TOKEN'];

describe.skipIf(!token)('Crowded sandbox', () => {
  it('lists organizations with the sandbox token', async () => {
    const baseUrl = process.env['CROWDED_BASE_URL'];
    const c = new CrowdedClient({ baseUrl: baseUrl ? baseUrl : SANDBOX_BASE_URL, token: token! });
    const r = await c.get('/organizations', { 'pagination[limit]': 1 });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data)).toBe(true);
  });
});

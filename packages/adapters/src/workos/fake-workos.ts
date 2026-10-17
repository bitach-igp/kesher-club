// In-memory WorkOS for tests: /connections, /sso/token and /directory_users. A code is
// `ok:<subject>:<email>[:group1,group2][;org=<workos org id>]`; org_workos_outage has an inactive connection.
import { createHmac } from 'node:crypto';

export interface FakeWorkOsOptions {
  apiKey: string;
  webhookSecret: string;
  /** workosOrganizationId → directoryId */
  directories: Record<string, string>;
}

export function fakeWorkOs(opts: FakeWorkOsOptions) {
  const tokenRequests: Record<string, string>[] = [];
  const directoryUsers = new Map<string, { id: string; idp_id: string; organization_id: string; emails: { primary: boolean; value: string }[]; state: 'active' | 'inactive' }[]>();
  let outage = false;

  const fetchImpl: typeof globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (outage) return new Response('', { status: 503 });
    if (headers['authorization'] !== `Bearer ${opts.apiKey}`) return Response.json({ message: 'Unauthorized' }, { status: 401 });
    if (url.pathname === '/connections') {
      const org = url.searchParams.get('organization_id') ?? '';
      if (org === 'org_workos_outage') return Response.json({ data: [{ id: 'conn_outage', state: 'inactive' }] });
      if (!(org in opts.directories)) return Response.json({ data: [] });
      return Response.json({ data: [{ id: `conn_${org}`, state: 'active', connection_type: 'OktaSAML' }] });
    }
    if (url.pathname === '/sso/token' && init?.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      tokenRequests.push(form);
      const m = /^ok:([\w-]+):([^:;]+)(?::([\w,-]+))?(?:;org=([\w-]+))?$/.exec(form['code'] ?? '');
      if (!m || form['grant_type'] !== 'authorization_code') return Response.json({ error: 'invalid_grant', error_description: 'The code is invalid' }, { status: 400 });
      const [, subject, email, groups, orgOverride] = m;
      return Response.json({ access_token: 'at_test', profile: { object: 'profile', id: `prof_${subject}`, idp_id: subject, organization_id: orgOverride ?? 'org_workos_yeshiva', connection_id: 'conn_1', connection_type: 'OktaSAML', email, first_name: 'Staff', last_name: subject, groups: groups ? groups.split(',') : [] } });
    }
    if (url.pathname === '/directory_users') {
      const dir = url.searchParams.get('directory') ?? '';
      const all = directoryUsers.get(dir) ?? [];
      const after = url.searchParams.get('after');
      const start = after ? all.findIndex((u) => u.id === after) + 1 : 0;
      const page = all.slice(start, start + 2);
      const last = page.at(-1);
      return Response.json({ data: page, list_metadata: { before: null, after: last && start + 2 < all.length ? last.id : null } });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetch: fetchImpl,
    tokenRequests,
    setOutage: (on: boolean) => void (outage = on),
    seedDirectory(directoryId: string, users: { subject: string; email: string; active?: boolean; organizationId?: string }[]) {
      directoryUsers.set(directoryId, users.map((u, i) => ({ id: `directory_user_${i}`, idp_id: u.subject, organization_id: u.organizationId ?? 'org_workos_yeshiva', emails: [{ primary: true, value: u.email }], state: u.active === false ? 'inactive' : 'active' })));
    },
    sign(rawBody: string, atUnix: number): string {
      return `t=${atUnix}, v1=${createHmac('sha256', opts.webhookSecret).update(`${atUnix}.${rawBody}`).digest('hex')}`;
    },
  };
}

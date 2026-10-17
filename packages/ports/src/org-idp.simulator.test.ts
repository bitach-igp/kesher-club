import { orgIdPContract } from './org-idp.contract.ts';
import { OrgIdPSimulator } from './org-idp.simulator.ts';

orgIdPContract('simulator', () => new OrgIdPSimulator(), {
  orgId: 'org_yeshiva_a',
  scimBearer: 'scim_org_yeshiva_a',
  codeFor: (subject, email) => `ok:${subject}:${email}`,
  outageOrgId: 'org_outage',
});

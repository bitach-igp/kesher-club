// The demo's people (T-0032): who the eighteen money flows in docs/bank-review/money-flows.md start from,
// and a passkey each can sign in with on every run. Names and phones are fictional: phones sit in the
// reserved 555-01xx range. A persona's key derives everything else (device id, passkey, idempotency keys),
// so a second seed run finds the first run's people instead of making new ones.
// Browser-safe (the member app's development build imports it for its persona picker, T-0033): no
// `node:` imports, and the passkey comes from @kesher/ports/seeded, which is WebCrypto only.
import { SeededPasskey } from '@kesher/ports/seeded';

export type Market = 'US' | 'IL';
export type Currency = 'USD' | 'ILS';

export interface Persona {
  /** Stable key: device id, passkey and idempotency keys derive from it. */
  key: string;
  name: string;
  /** E.164, in the fictional 555-01xx range. */
  phone: string;
  /** The market whose walkthroughs use this persona. The party itself has no market: every member holds both purses. */
  market: Market;
  /** T2 also issues the virtual card (card.virtual is on in the demo). */
  kyc: 'T1' | 'T2';
  /** Card loads (fixture pm_ok, settled at once) that fund the purses, in minor units. */
  loads: readonly { currency: Currency; minor: bigint }[];
  /** The recordings (docs/bank-review/README.md) that start from this persona. */
  recs: readonly string[];
  role: string;
  /** Institution staff role the seed grants at the demo yeshiva through the admin API (T-0034). */
  staff?: 'finance';
}

export const PERSONAS: readonly Persona[] = [
  { key: 'dana', name: 'Dana Example', phone: '+15555550101', market: 'US', kyc: 'T2', loads: [{ currency: 'USD', minor: 50_000n }], recs: ['REC-01', 'REC-02', 'REC-04', 'REC-05', 'REC-07', 'REC-09', 'REC-16'], role: 'US member, sender' },
  { key: 'avi', name: 'Avi Example', phone: '+15555550102', market: 'US', kyc: 'T1', loads: [], recs: ['REC-05', 'REC-08'], role: 'US member, Dana pays him' },
  { key: 'noa', name: 'Noa Example', phone: '+15555550103', market: 'IL', kyc: 'T2', loads: [{ currency: 'ILS', minor: 500_000n }, { currency: 'USD', minor: 10_000n }], recs: ['REC-03', 'REC-07', 'REC-08', 'REC-10', 'REC-13'], role: 'IL member, both purses' },
  { key: 'maya', name: 'Maya Example', phone: '+15555550104', market: 'IL', kyc: 'T1', loads: [{ currency: 'ILS', minor: 100_000n }], recs: ['REC-06'], role: 'new pair, sender' },
  { key: 'eli', name: 'Eli Example', phone: '+15555550105', market: 'IL', kyc: 'T1', loads: [], recs: ['REC-06'], role: 'new pair, recipient; has never been paid by Maya' },
  { key: 'tamar', name: 'Tamar Example', phone: '+15555550106', market: 'US', kyc: 'T2', loads: [{ currency: 'USD', minor: 20_000n }], recs: ['REC-12'], role: 'member with an open virtual card' },
  { key: 'ruth', name: 'Ruth Example', phone: '+15555550107', market: 'US', kyc: 'T1', loads: [{ currency: 'USD', minor: 3_000n }], recs: ['REC-17'], role: 'ready to close: card-loaded money only, no holds' },
  { key: 'ben', name: 'Ben Example', phone: '+15555550108', market: 'US', kyc: 'T1', loads: [], recs: ['REC-01'], role: 'funder; the link to a member is missing (see docs/setup/demo.md)' },
  { key: 'rivka', name: 'Rivka Example', phone: '+15555550109', market: 'IL', kyc: 'T2', loads: [], recs: ['REC-14', 'REC-15'], role: 'yeshiva finance: imports the roster, requests runs and payouts; the yeshiva\'s KYB control person', staff: 'finance' },
  { key: 'shimon', name: 'Shimon Example', phone: '+15555550110', market: 'IL', kyc: 'T1', loads: [], recs: ['REC-14'], role: 'yeshiva finance: the second approver', staff: 'finance' },
];

/**
 * The demo yeshiva (T-0034): onboarded by one staff admin, its finance staff granted by that admin and
 * approved by a second (REQ-ADM-004), and its roster imported by its first finance persona. The roster's
 * names and funder addresses are fictional; `example.test` never resolves.
 */
export const INSTITUTION = {
  key: 'yeshiva',
  name: 'Yeshivat Kesher (demo)',
  market: 'IL' as Market,
  /** Simulator identity-provider subjects (apps/simulators/src/oidc.ts): Ada proposes, Abe approves. */
  admins: ['staff-admin-1', 'staff-admin-2'] as const,
  /**
   * Cleo Compliance runs the yeshiva's automated KYB checks and decides it (T-0621, T-0622), with Rivka (T2)
   * as its control person and signatory; she records its own bank account and Carl approves it (T-0623).
   */
  compliance: 'staff-compliance-1',
  secondCompliance: 'staff-compliance-2',
  kybControl: 'rivka',
  /** The simulator's clean amuta number (a `456` ending), and a fictional IBAN with a valid checksum. */
  identifier: '580123456',
  payoutIban: 'IL620108000000099999999',
  roster: {
    csv: ['name,funder_email,programme', 'Student One Example,funder.one@example.test,Shiur Alef', 'Student Two Example,funder.two@example.test,Shiur Alef', 'Student Three Example,funder.three@example.test,Shiur Bet'].join('\n'),
    mapping: { memberName: 'name', funderEmail: 'funder_email', programme: 'programme' },
  },
} as const;

/** Personas the contract cannot make yet. Listed, never created through SQL. */
export const MISSING: readonly { who: string; recs: readonly string[]; why: string }[] = [
  { who: 'Funder linked to a member (Ben to Dana)', recs: ['REC-01', 'REC-04'], why: 'POST /memberships needs a plan in billing.plan_version, and no endpoint or migration creates one' },
  { who: 'Active roster members', recs: ['REC-14', 'REC-15'], why: 'a roster import makes invited members, and nothing over HTTP activates them' },
  { who: 'Allowance schedule', recs: ['REC-14'], why: 'no endpoint creates org.allowance_schedule' },
];

export const deviceIdOf = (p: Persona): string => `demo-${p.key}`;

// One device per persona per process, so assertions made within the same millisecond still count up.
const devices = new Map<string, Promise<SeededPasskey>>();
export const passkeyOf = (p: Persona): Promise<SeededPasskey> => devices.get(p.key) ?? devices.set(p.key, SeededPasskey.fromSeed(p.key)).get(p.key)!;

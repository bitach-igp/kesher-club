// Automated KYB checks (T-0622, REQ-INS-011, ADR-017): ask the KybPort what the register, the exempt-status
// source and screening say about an institution and the people in its record, and write one check row per
// answer, with the provider and its reference as evidence. Every port call is made before anything is written,
// so an outage halfway through records nothing. Behind `institutions.kyb.checks`: a simulator's "clear" must
// never count as evidence in production, so until a vendor is bound and the flag is on, compliance records
// checks by hand (T-0620).
import { DomainError } from '@kesher/domain';
import { KybError, type EntityLookup, type ExemptStatus, type KybMarket, type KybPort, type ScreeningResult } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { CheckKind, CheckResult, InstitutionKyb, KybRecord } from './kyb.ts';

export const KYB_CHECKS_FLAG = 'institutions.kyb.checks';

export interface KybChecksDeps {
  db: Database;
  kyb: InstitutionKyb;
  flags: FeatureFlags;
  /** The institution's market decides the register asked, and the binding that answers. */
  port: (market: KybMarket) => KybPort;
  /** The provider bound for a market, recorded on every check row. */
  provider: (market: KybMarket) => string;
}

type Row = { kind: CheckKind; personId?: string; result: CheckResult; evidenceRef: string; detail: Record<string, unknown> };

export class KybChecks {
  private readonly d: KybChecksDeps;
  constructor(d: KybChecksDeps) {
    this.d = d;
  }

  /**
   * Runs registry, identifier, exempt-status and screening checks for the institution under `identifier` (an
   * amuta or company number in Israel, an EIN in the US) and `legalName`, then answers the record.
   */
  async run(institutionId: string, input: { identifier: unknown; legalName: unknown }, by: string, now: Date): Promise<KybRecord> {
    if (!(await this.d.flags.isOn(KYB_CHECKS_FLAG))) throw new DomainError('FEATURE_OFF', 'Automated KYB checks are not on yet; record checks by hand');
    const identifier = typeof input.identifier === 'string' ? input.identifier.trim() : '';
    const legalName = typeof input.legalName === 'string' ? input.legalName.trim() : '';
    if (!identifier || !legalName || legalName.length > 200) throw new DomainError('VALIDATION_FAILED', 'identifier and legalName (up to 200 characters) are required');
    const inst = await this.d.db.query<{ market: KybMarket }>('select market from org.institution where id = $1', [institutionId]);
    const market = inst.rows[0]?.market;
    if (!market) throw new DomainError('NOT_FOUND', 'Institution not found');
    const people = (await this.d.kyb.record(institutionId)).people;
    const port = this.d.port(market);

    let entity: EntityLookup;
    let exempt: ExemptStatus;
    let screened: readonly ScreeningResult[];
    try {
      [entity, exempt, screened] = await Promise.all([port.lookupEntity({ market, identifier, name: legalName }), port.exemptStatus({ market, identifier }), port.screen({ names: [legalName, ...people.map((p) => p.fullName)] })]);
    } catch (e) {
      if (e instanceof KybError && e.code === 'INVALID_IDENTIFIER') throw new DomainError('VALIDATION_FAILED', `${identifier} is not a valid ${market === 'IL' ? 'registry number' : 'EIN'}`);
      if (e instanceof KybError) throw new DomainError('PROVIDER_UNAVAILABLE', 'The KYB provider is unavailable; nothing was recorded');
      throw e;
    }

    const rows: Row[] = [
      {
        kind: 'registry',
        result: !entity.found ? 'missing' : entity.status === 'active' ? 'clear' : 'hit',
        evidenceRef: entity.reference,
        detail: { identifier, status: entity.status, ...(entity.entityType ? { entityType: entity.entityType } : {}) },
      },
      {
        kind: 'identifier',
        result: !entity.found ? 'missing' : entity.nameMatches ? 'clear' : 'hit',
        evidenceRef: entity.reference,
        // The registered name is what the own-name payout check (T-0623) compares against.
        detail: { identifier, legalName, ...(entity.registeredName ? { registeredName: entity.registeredName } : {}) },
      },
      {
        kind: 'exempt_status',
        result: exempt.status === 'shown' ? 'clear' : exempt.status === 'revoked' ? 'hit' : 'missing',
        evidenceRef: exempt.reference,
        detail: { status: exempt.status, ...(exempt.possibleChurch ? { possibleChurch: true } : {}), ...(exempt.properManagementYear ? { properManagementYear: exempt.properManagementYear } : {}) },
      },
    ];
    const subjects = [undefined, ...people.map((p) => p.id)];
    screened.forEach((s, i) => {
      for (const kind of ['sanctions', 'pep'] as const) {
        const matches = s.matches.filter((m) => m.kind === kind);
        rows.push({
          kind,
          ...(subjects[i] ? { personId: subjects[i] } : {}),
          result: matches.length ? 'hit' : 'clear',
          evidenceRef: matches.map((m) => m.reference).join(' ') || `screened:${kind}`,
          detail: matches.length ? { matches: matches.map(({ list, score, reference }) => ({ list, score, reference })) } : {},
        });
      }
    });
    const provider = this.d.provider(market);
    for (const r of rows) await this.d.kyb.recordCheck(institutionId, { ...r, provider }, by, now);
    return this.d.kyb.record(institutionId);
  }
}

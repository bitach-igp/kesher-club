// Keeping institution KYB current (T-0624, REQ-INS-013, REQ-INS-014, ADR-017), two daily jobs:
// - the rescreen asks the KybPort about every approved institution in this market and the people in its record.
//   A sanctions answer that differs from the latest check is recorded: a new potential match is a hit, which
//   suspends the institution's payouts and credit draws through the gate (T-0621) until compliance disposes
//   of it; a delisting is recorded clear. The same answer as last time writes nothing, so a false positive
//   compliance has disposed of is not raised again every morning, and a second run on a day writes nothing;
// - the refresh drops an approval past its review date to approved with limits (`refresh_overdue`).
// Registry and exempt-status polling join the rescreen once a vendor is bound (out of scope here).
import type { InstitutionKyb, KybCheck } from '@kesher/api/institutions/kyb';
import { KYB_CHECKS_FLAG } from '@kesher/api/institutions/kyb-checks';
import type { FeatureFlags } from '@kesher/api/billing/capabilities';
import type { Database } from '@kesher/api/db';
import { KybError, type KybMarket, type KybPort, type ScreeningMatch } from '@kesher/ports';

export interface RescreenResult {
  institutions: number;
  newMatches: number;
  cleared: number;
  /** Institutions the provider could not answer for; the next day's run asks again. */
  failed: number;
  skipped?: 'flag_off';
}

/** The references of a set of sanctions matches, order aside: what "the same answer" compares. */
const refs = (matches: readonly Pick<ScreeningMatch, 'reference'>[]): string => matches.map((m) => m.reference).sort().join(' ');
/** The last screening's answer, or undefined when the subject was never screened (missing or excepted counts as never). */
const previous = (c: KybCheck | undefined): string | undefined =>
  c?.result === 'hit' ? refs((c.detail['matches'] as { reference: string }[] | undefined) ?? []) : c?.result === 'clear' ? '' : undefined;

export class KybRescreen {
  private readonly db: Database;
  private readonly kyb: InstitutionKyb;
  private readonly flags: FeatureFlags;
  private readonly port: KybPort;
  private readonly provider: string;
  private readonly market: KybMarket;
  private readonly clock: () => Date;
  constructor(db: Database, kyb: InstitutionKyb, flags: FeatureFlags, port: KybPort, provider: string, market: KybMarket, clock: () => Date) {
    this.db = db;
    this.kyb = kyb;
    this.flags = flags;
    this.port = port;
    this.provider = provider;
    this.market = market;
    this.clock = clock;
  }

  async run(): Promise<RescreenResult> {
    const out: RescreenResult = { institutions: 0, newMatches: 0, cleared: 0, failed: 0 };
    // Like the checks themselves (T-0622): a simulator's answer is never evidence until a vendor is bound.
    if (!(await this.flags.isOn(KYB_CHECKS_FLAG))) return { ...out, skipped: 'flag_off' };
    const now = this.clock();
    for (const inst of await this.approved()) {
      out.institutions += 1;
      const record = await this.kyb.record(inst.id);
      let screened;
      try {
        screened = await this.port.screen({ names: [inst.legalName, ...record.people.map((p) => p.fullName)] });
      } catch (e) {
        if (!(e instanceof KybError)) throw e;
        out.failed += 1;
        continue;
      }
      const subjects = [undefined, ...record.people.map((p) => p.id)];
      for (const [i, answer] of screened.entries()) {
        const personId = subjects[i];
        const matches = answer.matches.filter((m) => m.kind === 'sanctions');
        const last = previous(record.checks.find((c) => c.kind === 'sanctions' && c.personId === personId));
        if (last !== undefined && refs(matches) === last) continue;
        await this.kyb.recordCheck(
          inst.id,
          {
            kind: 'sanctions',
            ...(personId ? { personId } : {}),
            result: matches.length ? 'hit' : 'clear',
            provider: this.provider,
            evidenceRef: refs(matches) || 'screened:sanctions',
            detail: { rescreen: true, ...(matches.length ? { matches: matches.map(({ list, score, reference }) => ({ list, score, reference })) } : {}) },
          },
          undefined,
          now,
        );
        if (matches.length) out.newMatches += 1;
        else out.cleared += 1;
      }
    }
    return out;
  }

  /** Approved institutions in this market, under the legal name their identifier check was run with. */
  private async approved(): Promise<{ id: string; legalName: string }[]> {
    const r = await this.db.query<{ id: string; legal_name: string }>(
      `select i.id, coalesce((select k.detail->>'legalName' from org.kyb_check k where k.institution_id = i.id and k.kind = 'identifier' order by k.seq desc limit 1), i.name) as legal_name
         from org.institution i
         join lateral (select d.status from org.kyb_decision d where d.institution_id = i.id order by d.seq desc limit 1) d on true
        where i.market = $1 and d.status in ('approved', 'approved_with_limits')
        order by i.id`,
      [this.market],
    );
    return r.rows.map((x) => ({ id: x.id, legalName: x.legal_name }));
  }
}

export class KybRefresh {
  private readonly kyb: Pick<InstitutionKyb, 'refreshOverdue'>;
  private readonly clock: () => Date;
  constructor(kyb: Pick<InstitutionKyb, 'refreshOverdue'>, clock: () => Date) {
    this.kyb = kyb;
    this.clock = clock;
  }

  async run(now: Date = this.clock()): Promise<{ lapsed: number }> {
    return { lapsed: (await this.kyb.refreshOverdue(now)).length };
  }
}

// PassPort simulator. Fixture: memberId "m_outage" -> PROVIDER_UNAVAILABLE.
import { IdempotencyStore, Sequence } from './base.ts';
import { PassError, type ClubPass, type PassPlatform, type PassPort } from './pass.ts';

export class PassSimulator implements PassPort {
  private readonly passes = new Map<string, ClubPass>();
  private readonly idem = new IdempotencyStore<ClubPass>();
  private readonly ids = new Sequence('pass');

  async create(input: { platform: PassPlatform; memberId: string; fields: Record<string, string> }, key: string): Promise<ClubPass> {
    if (input.memberId === 'm_outage') throw new PassError('PROVIDER_UNAVAILABLE', 'Simulated wallet outage');
    if (!input.fields['memberName']) throw new PassError('VALIDATION_FAILED', 'memberName field required');
    return this.idem.run(key, async () => {
      const passId = this.ids.next();
      const p: ClubPass = { passId, platform: input.platform, memberId: input.memberId, url: this.url(input.platform, passId, 1), version: 1, fields: { ...input.fields } };
      this.passes.set(passId, p);
      return { ...p };
    });
  }

  async update(passId: string, fields: Record<string, string>, key: string): Promise<ClubPass> {
    return this.idem.run(key, async () => {
      const p = this.must(passId);
      const next: ClubPass = { ...p, version: p.version + 1, fields: { ...p.fields, ...fields }, url: this.url(p.platform, passId, p.version + 1) };
      this.passes.set(passId, next);
      return { ...next };
    });
  }

  async get(passId: string): Promise<ClubPass> {
    return { ...this.must(passId) };
  }

  private url(platform: PassPlatform, passId: string, version: number): string {
    return platform === 'apple' ? `https://passes.sim.kesher.example/${passId}/v${version}.pkpass` : `https://pay.google.com/gp/v/save/sim-${passId}-v${version}`;
  }

  private must(id: string): ClubPass {
    const p = this.passes.get(id);
    if (!p) throw new PassError('UNKNOWN_PASS', id);
    return p;
  }
}

// KybPort simulator. Deterministic fixtures, by the identifier's last digits:
// - `…000`: struck off the register;
// - `…111`: the register holds another name, so the name does not match;
// - `…222`: no exempt record (IL: no ניהול תקין; US: possibly a church);
// - `…444`: exempt status revoked;
// - `…999`: PROVIDER_UNAVAILABLE.
// Anything else is active, named as given, and exempt (IL: ניהול תקין for the clock's year).
// Screening, by name: a name containing "Sanctioned" matches OFAC SDN; one containing "Exposed" is a PEP. A
// malformed identifier answers INVALID_IDENTIFIER. Nothing here holds or returns personal data beyond the
// names given.
import { type Clock, fixedClock } from './base.ts';
import { KybError, validKybIdentifier, type EntityLookup, type ExemptStatus, type KybMarket, type KybPort, type ScreeningResult } from './kyb.ts';

const digits = (identifier: string): string => identifier.replace(/\D/g, '');

export class KybSimulator implements KybPort {
  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async lookupEntity(input: { market: KybMarket; identifier: string; name: string }): Promise<EntityLookup> {
    const id = this.check(input.market, input.identifier);
    const reference = `sim-registry:${input.market}:${id}`;
    const entityType = input.market === 'US' ? 'nonprofit_corporation' : id.startsWith('58') ? 'amuta' : 'public_benefit_company';
    if (id.endsWith('000')) return { found: true, status: 'struck_off', registeredName: input.name, nameMatches: true, entityType, reference };
    if (id.endsWith('111')) return { found: true, status: 'active', registeredName: 'Another Registered Name', nameMatches: false, entityType, reference };
    return { found: true, status: 'active', registeredName: input.name, nameMatches: true, entityType, reference };
  }

  async exemptStatus(input: { market: KybMarket; identifier: string }): Promise<ExemptStatus> {
    const id = this.check(input.market, input.identifier);
    const reference = `sim-exempt:${input.market}:${id}`;
    if (id.endsWith('222')) return { status: 'not_found', ...(input.market === 'US' ? { possibleChurch: true } : {}), reference };
    if (id.endsWith('444')) return { status: 'revoked', reference };
    return { status: 'shown', ...(input.market === 'IL' ? { properManagementYear: this.clock.now().getUTCFullYear() } : {}), reference };
  }

  async screen(input: { names: readonly string[] }): Promise<readonly ScreeningResult[]> {
    return input.names.map((name, i) => ({
      name,
      matches: [
        ...(/sanctioned/i.test(name) ? [{ kind: 'sanctions' as const, list: 'OFAC SDN', score: 0.92, reference: `sim-screen:${i}:sdn` }] : []),
        ...(/exposed/i.test(name) ? [{ kind: 'pep' as const, list: 'PEP', score: 0.81, reference: `sim-screen:${i}:pep` }] : []),
      ],
    }));
  }

  private check(market: KybMarket, identifier: string): string {
    if (!validKybIdentifier(market, identifier)) throw new KybError('INVALID_IDENTIFIER', `Not a ${market === 'IL' ? 'registry number' : 'EIN'}`);
    const id = digits(identifier);
    if (id.endsWith('999')) throw new KybError('PROVIDER_UNAVAILABLE', 'Simulated registry outage');
    return id;
  }
}

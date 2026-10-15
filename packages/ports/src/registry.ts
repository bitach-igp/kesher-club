// Provider registry: capability -> provider -> mode, per market (Tab 1 "The switch").
// Bindings live in the provider_binding table in production; this is the in-process resolver.

export type Mode = 'sim' | 'sandbox' | 'live';
export type Market = 'US' | 'IL';

export interface Binding {
  capability: string;
  market: Market;
  provider: string;
  mode: Mode;
}

export type Factory<P> = (mode: Mode) => P;

export class ProviderRegistry {
  private readonly factories = new Map<string, Factory<unknown>>();
  private readonly bindings = new Map<string, Binding>();

  register<P>(capability: string, provider: string, factory: Factory<P>): void {
    this.factories.set(`${capability}/${provider}`, factory as Factory<unknown>);
  }

  bind(b: Binding): void {
    if (!this.factories.has(`${b.capability}/${b.provider}`)) {
      throw new Error(`No adapter registered for ${b.capability}/${b.provider}`);
    }
    this.bindings.set(`${b.capability}@${b.market}`, b);
  }

  /** Fails closed: an unbound capability is an error, never a silent default (constitution art. 6). */
  resolve<P>(capability: string, market: Market): P {
    const b = this.bindings.get(`${capability}@${market}`);
    if (!b) throw new Error(`Capability ${capability} is not bound for ${market}`);
    const f = this.factories.get(`${b.capability}/${b.provider}`) as Factory<P>;
    return f(b.mode);
  }

  bindingFor(capability: string, market: Market): Binding | undefined {
    return this.bindings.get(`${capability}@${market}`);
  }
}

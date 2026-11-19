// Shared port building blocks (T-0008). Every mutating method takes an idempotency key (constitution art. 3, 6).

export interface Clock {
  now(): Date;
}

export const fixedClock = (iso = '2026-11-01T09:00:00Z'): Clock => {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    // Simulators expose `advance` through a cast; keeps the Clock interface minimal for adapters.
    ...({ advance: (ms: number) => void (t += ms) } as object),
  };
};

export type AdvanceableClock = Clock & { advance(ms: number): void };

/** Same key → same result, forever. Simulators and adapters use this to honour idempotency. */
export class IdempotencyStore<T> {
  private readonly results = new Map<string, T>();
  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.results.get(key);
    if (prior !== undefined) return prior;
    const value = await fn();
    this.results.set(key, value);
    return value;
  }
  has(key: string): boolean {
    return this.results.has(key);
  }
}

/** Deterministic ids for simulators: `${prefix}_000001`. Adapters use vendor ids. */
export class Sequence {
  private n = 0;
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  next(): string {
    return `${this.prefix}_${String(++this.n).padStart(6, '0')}`;
  }
}

export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

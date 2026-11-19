// Guards for the untyped JSON the vendor clients and mappers read.

/** A non-null, non-array object. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value when it is a string, else undefined. */
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

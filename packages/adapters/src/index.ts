// @kesher/adapters: vendor adapters behind the ports of @kesher/ports (constitution art. 1).
// One folder per vendor; each adapter passes its port's contract suite against an in-memory fake
// of the vendor API on every PR and against the vendor sandbox nightly.
export * from './stripe/index.ts';
export * from './airalo/index.ts';
export * from './cover-genius/index.ts';
export * from './apple/index.ts';
export * from './google/index.ts';
export * from './expo-push/index.ts';
export * from './postmark/index.ts';
export * from './twilio/index.ts';
export * from './concierge/index.ts';
export * from './workos/index.ts';

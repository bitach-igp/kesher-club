// Generates the key material Terraform leaves out (T-0056). Pure: it returns values and never writes, prints or logs them.
// The shapes are the ones the processes' own config schemas accept (apps/api/src/config.ts, apps/admin/src/config.ts); a test in
// apps/api checks each generated value against those schemas, so a change to either side fails there.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

/** Per environment, the key id the services are told (infra/terraform/envs/<env>/main.tf). */
export const kids = (env) => ({ jwt: `kesher-${env}-1`, admin: `kesher-${env}-admin-1` });

/** 32 random bytes, standard base64: the PII data and index keys. */
export const key32 = () => randomBytes(32).toString('base64');

/** A database password: 32 random bytes in base64url. URL-safe, so it needs no escaping in a connection string. */
export const password = () => randomBytes(32).toString('base64url');

/** A private ES256 JWK as JSON, with its key id. */
export function es256PrivateJwk(kid) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...privateKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
}

/** The public half of a private JWK, as a one-key JWKS document. */
export function publicJwks(privateJwk) {
  const { kty, crv, x, y, kid, alg, use } = privateJwk;
  return { keys: [{ kty, crv, x, y, kid, alg, use }] };
}

/**
 * Every secret this tool can generate, by Secrets Manager name (under kesher/<env>/). `staff-jwks` is the public half of
 * `admin-api-signing-key`, so the two come from one key pair and are generated together.
 */
export function generateAll(env) {
  const id = kids(env);
  const admin = es256PrivateJwk(id.admin);
  return {
    'jwt-signing-key': JSON.stringify(es256PrivateJwk(id.jwt)),
    'pii-data-key': key32(),
    'pii-index-key': key32(),
    'admin-api-signing-key': JSON.stringify(admin),
    'staff-jwks': JSON.stringify(publicJwks(admin)),
    'db-app-password': password(),
    'db-jit-password': password(),
    'db-readonly-password': password(),
    'db-migrator-password': password(),
  };
}

export const GENERATED = ['jwt-signing-key', 'pii-data-key', 'pii-index-key', 'admin-api-signing-key', 'staff-jwks', 'db-app-password', 'db-jit-password', 'db-readonly-password', 'db-migrator-password'];

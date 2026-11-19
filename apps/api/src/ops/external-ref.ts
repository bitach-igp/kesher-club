import type { SqlClient } from '../db.ts';

// Vendor ids live only in ops.external_ref: unique per (provider, external_id) and per (entity_type, entity_id, provider).
// These three cover the plain shapes; a lookup with another key shape stays a query at its call site.

export interface RefLink {
  entityType: string;
  entityId: string;
  provider: string;
  externalId: string;
}

/** Records the link; a link that already exists (either key) is left alone. True iff a row was inserted. */
export async function linkRef(db: SqlClient, l: RefLink): Promise<boolean> {
  const r = await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing`, [l.entityType, l.entityId, l.provider, l.externalId]);
  return r.rowCount > 0;
}

/** The vendor's id for this entity, if one is linked. */
export async function refOf(db: SqlClient, entityType: string, entityId: string, provider: string): Promise<string | undefined> {
  const r = await db.query<{ external_id: string }>('select external_id from ops.external_ref where entity_type = $1 and entity_id = $2 and provider = $3', [entityType, entityId, provider]);
  return r.rows[0]?.external_id;
}

/** The entity this vendor id is linked to, if any. */
export async function entityOf(db: SqlClient, entityType: string, provider: string, externalId: string): Promise<string | undefined> {
  const r = await db.query<{ entity_id: string }>('select entity_id from ops.external_ref where entity_type = $1 and provider = $2 and external_id = $3', [entityType, provider, externalId]);
  return r.rows[0]?.entity_id;
}

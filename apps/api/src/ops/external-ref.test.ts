import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { entityOf, linkRef, refOf } from './external-ref.ts';

describe('ops.external_ref accessor', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const now = new Date('2026-03-01T10:00:00Z');

  it('links once and reads both ways', async () => {
    const id = uuidv7(now);
    expect(await linkRef(db, { entityType: 'unit', entityId: id, provider: 'p1', externalId: 'ext-1' })).toBe(true);
    expect(await refOf(db, 'unit', id, 'p1')).toBe('ext-1');
    expect(await entityOf(db, 'unit', 'p1', 'ext-1')).toBe(id);
  });

  it('answers undefined when nothing is linked, and for another type or provider', async () => {
    const id = uuidv7(now);
    await linkRef(db, { entityType: 'unit', entityId: id, provider: 'p1', externalId: 'ext-2' });
    expect(await refOf(db, 'unit', uuidv7(now), 'p1')).toBeUndefined();
    expect(await refOf(db, 'other', id, 'p1')).toBeUndefined();
    expect(await refOf(db, 'unit', id, 'p2')).toBeUndefined();
    expect(await entityOf(db, 'unit', 'p2', 'ext-2')).toBeUndefined();
    expect(await entityOf(db, 'other', 'p1', 'ext-2')).toBeUndefined();
  });

  it('keeps the first link when either key repeats', async () => {
    const id = uuidv7(now);
    const other = uuidv7(now);
    expect(await linkRef(db, { entityType: 'unit', entityId: id, provider: 'p1', externalId: 'ext-3' })).toBe(true);
    // Same entity and provider, another external id.
    expect(await linkRef(db, { entityType: 'unit', entityId: id, provider: 'p1', externalId: 'ext-3b' })).toBe(false);
    // Same provider and external id, another entity.
    expect(await linkRef(db, { entityType: 'unit', entityId: other, provider: 'p1', externalId: 'ext-3' })).toBe(false);
    expect(await refOf(db, 'unit', id, 'p1')).toBe('ext-3');
    expect(await entityOf(db, 'unit', 'p1', 'ext-3')).toBe(id);
  });
});

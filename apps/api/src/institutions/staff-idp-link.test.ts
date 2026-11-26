// TST-AUTH-008 staff IdP link (T-0789, REQ-AUTH-008): the table maps an institution's IdP subject to a staff party, so a
// directory event can find who to deprovision. Email is never the key. A link needs an ACTIVE staff row of the same
// institution; one subject maps to one party and one party to one institution; a link is never deleted, only unlinked.
// The grants are checked under the real `club_app` role: select, insert, and update of `unlinked_at` only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { AuditService } from '../audit/service.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { StaffIdpLinks, checkedSubject, isValidSubject } from './staff-idp-link.ts';

let db: TestDatabase;
let links: StaffIdpLinks;
const NOW = new Date('2026-11-24T09:00:00Z');
const LATER = new Date('2026-11-24T10:00:00Z');
const OHR = uuidv7(NOW);
const NER = uuidv7(NOW);
const RIVKA = uuidv7(NOW); // active admin of Ohr
const AVI = uuidv7(NOW); // active staff of Ohr
const GONE = uuidv7(NOW); // inactive staff of Ohr
const TAL = uuidv7(NOW); // active staff of Ner
const OUTSIDER = uuidv7(NOW); // not staff anywhere
const SYSTEM = { actorId: '00000000-0000-7000-8000-000000000000', actorRole: 'system' };

const rows = async (where = 'true') => (await db.query<{ institution_id: string; idp_subject: string; party_id: string; unlinked_at: Date | null }>(`select institution_id, idp_subject, party_id, unlinked_at from org.staff_idp_link where ${where} order by linked_at, id`)).rows;
const audits = async (action: string) => (await db.query<{ subject: string; payload: Record<string, unknown> }>('select subject, payload from audit.entry where action = $1 order by seq', [action])).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  links = new StaffIdpLinks({ db, audit: new AuditService(db) });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Beit Ner', 'IL')`, [OHR, NER]);
  await db.query(`insert into org.staff (party_id, institution_id, role, active) values ($1, $2, 'admin', true), ($3, $2, 'staff', true), ($4, $2, 'staff', false), ($5, $6, 'staff', true)`, [RIVKA, OHR, AVI, GONE, TAL, NER]);
});
afterAll(async () => db.close());

describe('staff IdP link (TST-AUTH-008, T-0789)', () => {
  it('link writes one row and an audit row; a repeat is a no-op', async () => {
    const first = await links.link(OHR, 'directory_user_01A', RIVKA, SYSTEM, NOW);
    const again = await links.link(OHR, 'directory_user_01A', RIVKA, SYSTEM, LATER);
    expect(again).toEqual(first);
    expect(first).toMatchObject({ institutionId: OHR, subject: 'directory_user_01A', partyId: RIVKA });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ institution_id: OHR, idp_subject: 'directory_user_01A', party_id: RIVKA, unlinked_at: null });
    const a = await audits('institution.staff.idp_link');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ subject: RIVKA });
    expect(JSON.stringify(a[0]!.payload)).not.toContain('directory_user_01A');
  });

  it('a second party for the same (institution, subject) answers 409 IDEMPOTENCY_CONFLICT and the first link is unchanged', async () => {
    await expect(links.link(OHR, 'directory_user_01A', AVI, SYSTEM, LATER)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await links.find(OHR, 'directory_user_01A')).toBe(RIVKA);
    expect(await rows()).toHaveLength(1);
  });

  it('one party cannot be linked to two institutions (nor to a second live subject)', async () => {
    await expect(links.link(NER, 'directory_user_01B', RIVKA, SYSTEM, LATER)).rejects.toMatchObject({ code: 'NOT_FOUND' }); // not staff of Ner
    // a party that moved institutions while a live link to the first stays: the database refuses the second live link
    await expect(db.query(`insert into org.staff_idp_link (id, institution_id, idp_subject, party_id, linked_at) values ($1, $2, 'directory_user_01B', $3, $4)`, [uuidv7(NOW), NER, RIVKA, NOW])).rejects.toThrow(/unique|duplicate/i);
    await expect(links.link(OHR, 'directory_user_01C', RIVKA, SYSTEM, LATER)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await rows()).toHaveLength(1);
  });

  it('a party that is not active staff of that institution is refused', async () => {
    for (const [inst, party] of [[OHR, GONE], [OHR, OUTSIDER], [OHR, TAL], [NER, AVI]] as const) {
      await expect(links.link(inst, `directory_user_${party.slice(-6)}`, party, SYSTEM, LATER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await rows()).toHaveLength(1);
    expect(await audits('institution.staff.idp_link')).toHaveLength(1);
  });

  it('find returns the party for a live link, scoped to the institution, or undefined', async () => {
    expect(await links.find(OHR, 'directory_user_01A')).toBe(RIVKA);
    expect(await links.find(NER, 'directory_user_01A')).toBeUndefined();
    expect(await links.find(OHR, 'DIRECTORY_USER_01A')).toBeUndefined();
    expect(await links.find(OHR, 'rivka@example.com')).toBeUndefined();
  });

  it('the subject is validated: empty, blank, control characters and oversize are refused', async () => {
    for (const s of ['', '   ', 'a\nb', 'x'.repeat(256)]) await expect(links.link(OHR, s, AVI, SYSTEM, LATER)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await links.find(OHR, '')).toBeUndefined();
  });

  it('unlink marks unlinked_at, audits once, and find then returns undefined; a repeat changes nothing', async () => {
    expect(await links.unlink(OHR, 'directory_user_01A', SYSTEM, LATER)).toBe(true);
    expect(await links.unlink(OHR, 'directory_user_01A', SYSTEM, new Date('2026-11-24T11:00:00Z'))).toBe(false);
    expect(await links.unlink(OHR, 'never_linked', SYSTEM, LATER)).toBe(false);
    expect(await links.find(OHR, 'directory_user_01A')).toBeUndefined();
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(new Date(stored[0]!.unlinked_at!).toISOString()).toBe(LATER.toISOString());
    const a = await audits('institution.staff.idp_unlink');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ subject: RIVKA });
  });

  it('after an unlink the subject and the party can be linked again; the history row stays', async () => {
    await links.link(OHR, 'directory_user_01A', AVI, SYSTEM, LATER);
    expect(await links.find(OHR, 'directory_user_01A')).toBe(AVI);
    await links.link(OHR, 'directory_user_02R', RIVKA, SYSTEM, LATER);
    expect(await rows()).toHaveLength(3);
    expect(await rows('unlinked_at is not null')).toHaveLength(1);
  });

  it('club_app can select, insert and set unlinked_at; it cannot update any other column or delete', async () => {
    const id = uuidv7(NOW);
    await db.asRole('club_app', (c) => c.query(`insert into org.staff_idp_link (id, institution_id, idp_subject, party_id, linked_at) values ($1, $2, 'directory_user_03T', $3, $4)`, [id, NER, TAL, NOW]));
    expect((await db.asRole('club_app', (c) => c.query(`select party_id from org.staff_idp_link where id = $1`, [id]))).rows).toHaveLength(1);
    for (const col of ['idp_subject', 'party_id', 'institution_id', 'linked_at', 'id']) {
      const value = col === 'idp_subject' ? `'other'` : col === 'linked_at' ? `now()` : col === 'id' ? `'${uuidv7(NOW)}'` : `'${col === 'institution_id' ? OHR : AVI}'`;
      await expect(db.asRole('club_app', (c) => c.query(`update org.staff_idp_link set ${col} = ${value} where id = '${id}'`))).rejects.toThrow(/permission denied/);
    }
    await expect(db.asRole('club_app', (c) => c.query(`update org.staff_idp_link set unlinked_at = null, party_id = party_id where id = '${id}'`))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query(`delete from org.staff_idp_link where id = '${id}'`))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query('delete from org.staff_idp_link'))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query('truncate org.staff_idp_link'))).rejects.toThrow(/permission denied/);
    await db.asRole('club_app', (c) => c.query(`update org.staff_idp_link set unlinked_at = $2 where id = $1`, [id, LATER]));
    expect((await rows(`idp_subject = 'directory_user_03T'`))[0]!.unlinked_at).not.toBeNull();
    // an unlinked row stays unlinked: it cannot be revived or its end moved, not even by setting unlinked_at itself
    await expect(db.asRole('club_app', (c) => c.query(`update org.staff_idp_link set unlinked_at = null where id = '${id}'`))).rejects.toThrow(/already unlinked/);
    await expect(db.asRole('club_app', (c) => c.query(`update org.staff_idp_link set unlinked_at = $2 where id = $1`, [id, new Date('2026-11-24T12:00:00Z')]))).rejects.toThrow(/already unlinked/);
    await expect(db.asRole('club_readonly', (c) => c.query('select 1 from org.staff_idp_link'))).rejects.toThrow(/permission denied/);
  });

  it('the database refuses an empty subject, an unlink before the link, and two live rows of one subject or one party', async () => {
    const ins = (inst: string, subject: string, party: string, unlinked?: Date) =>
      db.query(`insert into org.staff_idp_link (id, institution_id, idp_subject, party_id, linked_at, unlinked_at) values ($1, $2, $3, $4, $5, $6)`, [uuidv7(NOW), inst, subject, party, NOW, unlinked ?? null]);
    await expect(ins(OHR, '', OUTSIDER)).rejects.toThrow(/check/i);
    await expect(ins(OHR, 'x1', OUTSIDER, new Date('2026-11-24T08:00:00Z'))).rejects.toThrow(/check/i);
    await expect(ins(OHR, 'directory_user_01A', OUTSIDER)).rejects.toThrow(/unique|duplicate/i);
  });
});

describe('the shared subject rule (T-1122)', () => {
  it('1 to 255 characters, not blank, no control character; the same rule link() applies', () => {
    for (const ok of ['a', ' a ', 'x'.repeat(255), 'ünï-コード', 'a b']) expect(isValidSubject(ok), ok).toBe(true);
    for (const bad of ['', ' ', '\t', 'x'.repeat(256), 'a\u0000b', 'a\nb', 'a\u001Fb', 'a\u007Fb', 5, undefined, null]) expect(isValidSubject(bad), String(bad)).toBe(false);
    expect(checkedSubject('x'.repeat(255))).toBe('x'.repeat(255));
    expect(() => checkedSubject('x'.repeat(256))).toThrow(/1 to 255/);
  });
});

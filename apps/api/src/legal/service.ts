// Legal CMS (T-0304): versioned legal documents in en and he, consent records, and the re-accept
// rule. Versions and consents are insert-only (grants); a material version published after a
// party's last consent puts that document on the re-accept sheet (Tab 2 legal pages).
import { createHash } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';

export type DocKey = 'terms' | 'privacy' | 'cardholder' | 'esim' | 'insurance' | 'p2p' | 'funder';
export type Localised = { en: string; he: string };

export interface DocumentVersion {
  docKey: DocKey;
  version: number;
  title: Localised;
  body: Localised;
  hash: string;
  material: boolean;
  changeSummary?: Localised;
  effectiveAt: string;
  publishedAt: string;
}

export interface Consent {
  id: string;
  partyId: string;
  docKey: DocKey;
  version: number;
  hash: string;
  deviceId: string;
  ip: string;
  locale: 'en' | 'he';
  acceptedAt: string;
}

interface VersionRow {
  doc_key: DocKey;
  version: number;
  title_en: string;
  title_he: string;
  body_en: string;
  body_he: string;
  hash: string;
  material: boolean;
  change_summary_en: string | null;
  change_summary_he: string | null;
  effective_at: string | Date;
  published_at: string | Date;
}
interface ConsentRow {
  id: string;
  party_id: string;
  doc_key: DocKey;
  version: number;
  hash: string;
  device_id: string;
  ip: string;
  locale: 'en' | 'he';
  accepted_at: string | Date;
}

export class LegalService {
  constructor(private readonly db: Database) {}

  async publish(input: { docKey: DocKey; title: Localised; body: Localised; material: boolean; changeSummary?: Localised; publishedBy: string; effectiveAt: Date }): Promise<DocumentVersion> {
    if (!input.body.en.trim() || !input.body.he.trim()) throw new DomainError('VALIDATION_FAILED', 'Both en and he bodies are required (ui.hebrew)');
    const hash = createHash('sha256').update(`${input.docKey}\n${input.body.en}\n${input.body.he}`).digest('hex');
    return this.db.transaction(async (tx) => {
      const last = await tx.query<{ v: number | null }>('select max(version) as v from legal.document_version where doc_key = $1', [input.docKey]);
      const version = (last.rows[0]?.v ?? 0) + 1;
      await tx.query(
        `insert into legal.document_version (doc_key, version, title_en, title_he, body_en, body_he, hash, material, change_summary_en, change_summary_he, published_by, effective_at, published_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
        [input.docKey, version, input.title.en, input.title.he, input.body.en, input.body.he, hash, input.material, input.changeSummary?.en ?? null, input.changeSummary?.he ?? null, input.publishedBy, input.effectiveAt],
      );
      return (await this.get(input.docKey, version, tx))!;
    });
  }

  async get(docKey: DocKey, version: number, db: SqlClient = this.db): Promise<DocumentVersion | undefined> {
    const r = await db.query<VersionRow>('select * from legal.document_version where doc_key = $1 and version = $2', [docKey, version]);
    return r.rows[0] ? toVersion(r.rows[0]) : undefined;
  }

  /** The version in force at `at`. */
  async current(docKey: DocKey, at: Date): Promise<DocumentVersion> {
    const r = await this.db.query<VersionRow>('select * from legal.document_version where doc_key = $1 and effective_at <= $2 order by version desc limit 1', [docKey, at]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', `No ${docKey} in force`);
    return toVersion(r.rows[0]);
  }

  /** Records consent; the same (party, doc, version) is a no-op returning the original record. */
  async accept(input: { partyId: string; docKey: DocKey; version: number; deviceId: string; ip: string; locale: 'en' | 'he' }, now: Date): Promise<Consent> {
    const v = await this.get(input.docKey, input.version);
    if (!v) throw new DomainError('NOT_FOUND', 'Document version not found');
    try {
      await this.db.query(
        `insert into legal.consent (id, party_id, doc_key, version, hash, device_id, ip, locale, accepted_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuidv7(now), input.partyId, input.docKey, input.version, v.hash, input.deviceId, input.ip, input.locale, now],
      );
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
    }
    const r = await this.db.query<ConsentRow>('select * from legal.consent where party_id = $1 and doc_key = $2 and version = $3', [input.partyId, input.docKey, input.version]);
    return toConsent(r.rows[0]!);
  }

  /**
   * Documents the party must (re-)accept at `at`: for every doc with a version in force, the
   * latest material version in force is newer than the party's latest consent (or there is none).
   */
  async pending(partyId: string, at: Date): Promise<(DocumentVersion & { reason: 'first' | 'material_change' })[]> {
    const r = await this.db.query<VersionRow & { last_consented: number | null }>(
      `with in_force as (
         select distinct on (doc_key) * from legal.document_version where effective_at <= $2 order by doc_key, version desc
       ), last_material as (
         select doc_key, max(version) as version from legal.document_version where effective_at <= $2 and material group by doc_key
       ), consented as (
         select doc_key, max(version) as version from legal.consent where party_id = $1 group by doc_key
       )
       select f.*, c.version as last_consented
         from in_force f
         join last_material m on m.doc_key = f.doc_key
         left join consented c on c.doc_key = f.doc_key
        where c.version is null or c.version < m.version
        order by f.doc_key`,
      [partyId, at],
    );
    return r.rows.map((row) => ({ ...toVersion(row), reason: row.last_consented === null ? 'first' : 'material_change' }));
  }

  async consents(partyId: string): Promise<Consent[]> {
    const r = await this.db.query<ConsentRow>('select * from legal.consent where party_id = $1 order by accepted_at, version', [partyId]);
    return r.rows.map(toConsent);
  }
}

function toVersion(r: VersionRow): DocumentVersion {
  return {
    docKey: r.doc_key,
    version: r.version,
    title: { en: r.title_en, he: r.title_he },
    body: { en: r.body_en, he: r.body_he },
    hash: r.hash,
    material: r.material,
    ...(r.change_summary_en !== null ? { changeSummary: { en: r.change_summary_en, he: r.change_summary_he ?? '' } } : {}),
    effectiveAt: new Date(r.effective_at).toISOString(),
    publishedAt: new Date(r.published_at).toISOString(),
  };
}

function toConsent(r: ConsentRow): Consent {
  return { id: r.id, partyId: r.party_id, docKey: r.doc_key, version: r.version, hash: r.hash, deviceId: r.device_id, ip: r.ip, locale: r.locale, acceptedAt: new Date(r.accepted_at).toISOString() };
}

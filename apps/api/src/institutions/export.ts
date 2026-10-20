// Monthly reconciliation export (T-0606, REQ-INS-006): every ledger posting that touched an
// institution's money in a month, one row each, with totals that equal the ledger, as CSV and as XLSX
// built from the same rows. Member names and descriptions are data: written into cells, never into
// formulas (in the CSV a leading =, +, - or @ on a text cell is neutralised; XLSX inline strings are
// never evaluated) and never interpreted. The XLSX is a minimal OOXML package written here without a
// library: a stored (uncompressed) zip of the five parts Excel needs, with inline strings.
import { format, money, toWire, type Currency, type Money } from '@kesher/domain';
import { DomainError } from '@kesher/domain';
import type { Database } from '../db.ts';
import { SYSTEM_OWNER } from '../ledger/accounts.ts';
import { ok, requireRole, route, type Handler } from '../http.ts';

export type ExportKind = 'allowance' | 'fee' | 'reversal';

export interface ExportRow {
  date: string;
  journalId: string;
  kind: ExportKind;
  /** For a reversal, what it reversed; the totals count it against that kind. */
  reverses?: 'allowance' | 'fee';
  /** The roster name as the institution knows the member; untrusted display text. */
  memberName: string;
  memberPartyId: string;
  description: string;
  /** From the institution's point of view: allowances out are negative, fees in are positive. */
  amount: Money;
}

export interface MonthlyExport {
  institutionId: string;
  /** YYYY-MM. */
  month: string;
  currency: Currency;
  rows: ExportRow[];
  /** allowancesOut covers allowances and their reversals; feesIn fees and theirs; net is every row. */
  totals: { allowancesOut: Money; feesIn: Money; net: Money };
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** [start, end) of a month in UTC. */
export function monthBounds(month: string): { start: Date; end: Date } {
  if (!MONTH.test(month)) throw new RangeError(`Not a month: ${month}`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

interface ExportQueryRow {
  journal_id: string;
  kind: string;
  reversed_kind: string | null;
  effective_at: string | Date;
  amount_minor: string;
  metadata: Record<string, unknown>;
  /** The member whose wallet the journal touched: the other side of the institution_master posting. */
  member_party_id: string | null;
  member_name: string | null;
}

/**
 * Reads the institution's postings for the month: the institution's own account's side (T-0613; the
 * shared institution_master for journals from before it) of every allowance and
 * fee journal tagged with the institution, and of every reversal of one (a reversal carries no
 * metadata of its own; it is found through the journal it reverses). The member is the owner of the
 * wallet the same journal touched, so allowances, which tag only the institution, still name them.
 */
export async function monthlyExport(db: Database, institutionId: string, month: string, currency: Currency): Promise<MonthlyExport> {
  const { start, end } = monthBounds(month);
  const r = await db.query<ExportQueryRow>(
    `select j.id as journal_id, j.kind, o.kind as reversed_kind, j.effective_at, p.amount_minor::text, j.metadata,
            w.owner_party_id as member_party_id,
            (select m.member_name from org.member m where m.institution_id = $1::uuid and m.member_party_id = w.owner_party_id order by m.updated_at desc limit 1) as member_name
       from ledger.journal j
       left join ledger.journal o on o.id = j.reverses_id
       join ledger.posting p on p.journal_id = j.id
       -- The institution's own account (T-0613), or the shared one journals posted to before it existed.
       join ledger.account a on a.id = p.account_id and a.type = 'institution_master' and a.currency = $4 and (a.owner_party_id = $1::uuid or a.owner_party_id = $5::uuid)
       left join lateral (
         select a2.owner_party_id from ledger.posting p2 join ledger.account a2 on a2.id = p2.account_id
          where p2.journal_id = j.id and a2.type in ('wallet', 'pending') and a2.owner_party_id is not null
          order by p2.id limit 1
       ) w on true
      where (j.metadata->>'institutionId' = $1::text or (j.kind = 'reversal' and o.metadata->>'institutionId' = $1::text))
        and j.effective_at >= $2 and j.effective_at < $3
      order by j.effective_at, j.id`,
    [institutionId, start, end, currency, SYSTEM_OWNER],
  );
  const rows: ExportRow[] = r.rows.map((x) => {
    // institution_master is credit-normal: a debit (+) is money leaving the institution, a credit (−) money arriving.
    const minor = -BigInt(x.amount_minor);
    const kind: ExportKind = x.kind === 'allowance' ? 'allowance' : x.kind === 'reversal' ? 'reversal' : 'fee';
    const reverses = kind === 'reversal' ? (x.reversed_kind === 'allowance' ? 'allowance' : 'fee') : undefined;
    const metaMember = typeof x.metadata['memberPartyId'] === 'string' ? x.metadata['memberPartyId'] : '';
    const description = typeof x.metadata['description'] === 'string' ? x.metadata['description'] : kind === 'allowance' ? 'Allowance' : kind === 'reversal' ? `Reversal of ${reverses}` : 'Fee';
    return {
      date: new Date(x.effective_at).toISOString().slice(0, 10),
      journalId: x.journal_id,
      kind,
      ...(reverses ? { reverses } : {}),
      memberName: x.member_name ?? '',
      memberPartyId: x.member_party_id ?? metaMember,
      description,
      amount: money(minor, currency),
    };
  });
  const sum = (f: (r: ExportRow) => boolean) => rows.filter(f).reduce((a, r) => a + r.amount.minor, 0n);
  const allowancesOut = sum((x) => x.kind === 'allowance' || x.reverses === 'allowance');
  const feesIn = sum((x) => x.kind === 'fee' || x.reverses === 'fee');
  return { institutionId, month, currency, rows, totals: { allowancesOut: money(allowancesOut, currency), feesIn: money(feesIn, currency), net: money(allowancesOut + feesIn, currency) } };
}

export const HEADERS = ['date', 'journal_id', 'kind', 'member_name', 'member_party_id', 'description', 'amount_minor', 'currency', 'amount'] as const;
/** The columns that carry text people typed; the only ones a spreadsheet could mistake for a formula. */
export const TEXT_COLUMNS: ReadonlySet<number> = new Set([HEADERS.indexOf('member_name'), HEADERS.indexOf('description')]);

/** The same cells feed the CSV and the XLSX; amounts appear as minor units and as formatted money. */
export function cells(e: MonthlyExport): string[][] {
  const body = e.rows.map((r) => [r.date, r.journalId, r.kind, r.memberName, r.memberPartyId, r.description, r.amount.minor.toString(), r.amount.currency, format(r.amount)]);
  const totals = [
    ['', '', 'total', 'allowances_out', '', '', e.totals.allowancesOut.minor.toString(), e.currency, format(e.totals.allowancesOut)],
    ['', '', 'total', 'fees_in', '', '', e.totals.feesIn.minor.toString(), e.currency, format(e.totals.feesIn)],
    ['', '', 'total', 'net', '', '', e.totals.net.minor.toString(), e.currency, format(e.totals.net)],
  ];
  return [[...HEADERS], ...body, ...totals];
}

/** Text that a spreadsheet could read as a formula gets a leading apostrophe, so a member called "=HYPERLINK(...)" stays a name. */
export const neutralise = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** CSV: text columns neutralised (a CSV cell is whatever the reader makes of it), numbers left as numbers. */
export function toCsv(e: MonthlyExport): string {
  const esc = (v: string, ci: number) => {
    const s = TEXT_COLUMNS.has(ci) ? neutralise(v) : v;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `\uFEFF${cells(e)
    .map((row) => row.map(esc).join(','))
    .join('\r\n')}\r\n`;
}

// ---- a minimal XLSX writer ---------------------------------------------------------------------

const xml = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const col = (i: number): string => {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** XLSX: every cell an inline string, which Excel never evaluates, so the cells go in as they are. */
export function toXlsx(e: MonthlyExport): Uint8Array {
  const rows = cells(e)
    .map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`).join('')}</row>`)
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(e.month)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  return zipStored([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

const CRC_TABLE = new Uint32Array(256).map((_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed-size little-endian writes straight into one buffer; no byte-per-element JS arrays. */
class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  u16(n: number): this {
    this.view.setUint16(this.pos, n, true);
    this.pos += 2;
    return this;
  }
  u32(n: number): this {
    this.view.setUint32(this.pos, n >>> 0, true);
    this.pos += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  get length(): number {
    return this.pos;
  }
  done(): Uint8Array {
    if (this.pos !== this.buf.length) throw new Error(`zip writer: wrote ${this.pos} of ${this.buf.length} bytes`);
    return this.buf;
  }
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/** A zip with stored entries (method 0): enough for Excel, and nothing to get wrong about deflate. */
export function zipStored(entries: readonly (readonly [string, string])[]): Uint8Array {
  const enc = new TextEncoder();
  const parts = entries.map(([name, text]) => {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    return { nameB, data, crc: crc32(data) };
  });
  const localSize = parts.reduce((n, p) => n + LOCAL_HEADER + p.nameB.length + p.data.length, 0);
  const centralSize = parts.reduce((n, p) => n + CENTRAL_HEADER + p.nameB.length, 0);
  const w = new ByteWriter(localSize + centralSize + END_RECORD);
  const offsets: number[] = [];
  // Shared fields of both headers: version needed 2.0, UTF-8 names (bit 11), stored, DOS time 00:00 1980-01-01.
  const common = (p: (typeof parts)[number]) => w.u16(20).u16(0x0800).u16(0).u16(0).u16(0x21).u32(p.crc).u32(p.data.length).u32(p.data.length).u16(p.nameB.length);
  for (const p of parts) {
    offsets.push(w.length);
    w.u32(LOCAL_SIG);
    common(p).u16(0).bytes(p.nameB).bytes(p.data); // extra length, name, data
  }
  for (const [i, p] of parts.entries()) {
    w.u32(CENTRAL_SIG).u16(20); // version made by
    common(p).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offsets[i]!).bytes(p.nameB); // extra, comment, disk, internal attrs, external attrs, local offset, name
  }
  w.u32(END_SIG).u16(0).u16(0).u16(parts.length).u16(parts.length).u32(centralSize).u32(localSize).u16(0);
  return w.done();
}

/**
 * Reads a stored zip back the way a real reader does: the end record, then the central directory,
 * then each local entry it points at. Throws on anything malformed, so a test that reads what the
 * writer produced proves the file opens.
 */
export function unzipStored(bytes: Uint8Array): Map<string, string> {
  const dec = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (what: string): never => {
    throw new Error(`zip: ${what}`);
  };
  const endPos = bytes.length - END_RECORD;
  if (endPos < 0 || view.getUint32(endPos, true) !== END_SIG) fail('end record missing');
  const count = view.getUint16(endPos + 10, true);
  const cdSize = view.getUint32(endPos + 12, true);
  const cdOffset = view.getUint32(endPos + 16, true);
  if (cdOffset + cdSize !== endPos) fail('central directory does not end at the end record');
  const out = new Map<string, string>();
  let pos = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (pos + CENTRAL_HEADER > endPos || view.getUint32(pos, true) !== CENTRAL_SIG) fail(`central header ${i} missing`);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = dec.decode(bytes.subarray(pos + CENTRAL_HEADER, pos + CENTRAL_HEADER + nameLen));
    pos += CENTRAL_HEADER + nameLen + extraLen + commentLen;
    if (view.getUint32(local, true) !== LOCAL_SIG) fail(`local header for ${name} missing`);
    const localNameLen = view.getUint16(local + 26, true);
    const localExtraLen = view.getUint16(local + 28, true);
    const start = local + LOCAL_HEADER + localNameLen + localExtraLen;
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) fail(`crc mismatch for ${name}`);
    out.set(name, dec.decode(data));
  }
  if (pos !== endPos) fail('central directory size disagrees with its entries');
  return out;
}

/** The sheet's cells back out of the XML, row by row, for comparing with the CSV. */
export function sheetCells(sheetXml: string): string[][] {
  const unxml = (s: string) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  return [...sheetXml.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map((row) => [...row[1]!.matchAll(/<t>(.*?)<\/t>/g)].map((c) => unxml(c[1]!)));
}

export interface ExportFile {
  filename: string;
  contentType: string;
  base64: string;
  rows: number;
  totals: { allowancesOut: ReturnType<typeof toWire>; feesIn: ReturnType<typeof toWire>; net: ReturnType<typeof toWire> };
}

export function exportFile(e: MonthlyExport, fmt: 'csv' | 'xlsx'): ExportFile {
  const bytes = fmt === 'csv' ? new TextEncoder().encode(toCsv(e)) : toXlsx(e);
  return {
    filename: `kesher-${e.institutionId.slice(0, 8)}-${e.month}-${e.currency}.${fmt}`,
    contentType: fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: Buffer.from(bytes).toString('base64'),
    rows: e.rows.length,
    totals: { allowancesOut: toWire(e.totals.allowancesOut), feesIn: toWire(e.totals.feesIn), net: toWire(e.totals.net) },
  };
}

/** GET /institutions/{id}/collections/export?month=YYYY-MM&format=csv|xlsx[&currency=ILS] for the institution's staff. */
export function exportHandler(db: Database, staffInstitution: (partyId: string) => Promise<string | undefined>): Handler {
  return route(async (req) => {
    const principal = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    if ((await staffInstitution(principal.partyId)) !== institutionId) throw new DomainError('FORBIDDEN', 'Not staff of this institution');
    const month = String(req.query['month'] ?? '');
    if (!MONTH.test(month)) throw new DomainError('VALIDATION_FAILED', 'month must be YYYY-MM');
    const fmt = req.query['format'];
    if (fmt !== 'csv' && fmt !== 'xlsx') throw new DomainError('VALIDATION_FAILED', 'format must be csv or xlsx');
    const currency = req.query['currency'] ?? 'ILS';
    if (currency !== 'USD' && currency !== 'ILS') throw new DomainError('VALIDATION_FAILED', 'currency must be USD or ILS');
    return ok(exportFile(await monthlyExport(db, institutionId, month, currency), fmt));
  });
}

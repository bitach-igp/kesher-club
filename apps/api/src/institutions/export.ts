// Monthly reconciliation export (T-0606, REQ-INS-006): every ledger posting that touched an
// institution's money in a month, one row each, with totals that equal the ledger, as CSV and as XLSX
// built from the same rows. Member names are data: written into cells, never into formulas (a leading
// =, +, - or @ is neutralised) and never interpreted. The XLSX is a minimal OOXML package written here
// without a library: a stored (uncompressed) zip of the five parts Excel needs, with inline strings.
import { format, money, toWire, type Currency, type Money } from '@kesher/domain';
import { DomainError } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requireRole, route, type Handler } from '../http.ts';

export type ExportKind = 'allowance' | 'fee' | 'reversal';

export interface ExportRow {
  date: string;
  journalId: string;
  kind: ExportKind;
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
  totals: { allowancesOut: Money; feesIn: Money; net: Money };
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** [start, end) of a month in UTC. */
export function monthBounds(month: string): { start: Date; end: Date } {
  if (!MONTH.test(month)) throw new RangeError(`Not a month: ${month}`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/**
 * Reads the institution's postings for the month: the institution_master side of every allowance and
 * fee journal tagged with the institution, joined to the roster for the member's name.
 */
export async function monthlyExport(db: Database, institutionId: string, month: string, currency: Currency): Promise<MonthlyExport> {
  const { start, end } = monthBounds(month);
  const r = await db.query<{ journal_id: string; kind: string; effective_at: string | Date; amount_minor: string; metadata: Record<string, unknown>; member_name: string | null }>(
    `select j.id as journal_id, j.kind, j.effective_at, p.amount_minor::text, j.metadata,
            (select m.member_name from org.member m where m.institution_id = $1::uuid and m.member_party_id = (j.metadata->>'memberPartyId')::uuid order by m.updated_at desc limit 1) as member_name
       from ledger.journal j
       join ledger.posting p on p.journal_id = j.id
       join ledger.account a on a.id = p.account_id and a.type = 'institution_master' and a.currency = $4
      where j.metadata->>'institutionId' = $1::text and j.effective_at >= $2 and j.effective_at < $3
      order by j.effective_at, j.id`,
    [institutionId, start, end, currency],
  );
  const rows: ExportRow[] = r.rows.map((x) => {
    // institution_master is credit-normal: a debit (+) is money leaving the institution, a credit (−) money arriving.
    const minor = -BigInt(x.amount_minor);
    const kind: ExportKind = x.kind === 'allowance' ? 'allowance' : x.kind === 'reversal' ? 'reversal' : 'fee';
    const memberPartyId = typeof x.metadata['memberPartyId'] === 'string' ? x.metadata['memberPartyId'] : '';
    return {
      date: new Date(x.effective_at).toISOString().slice(0, 10),
      journalId: x.journal_id,
      kind,
      memberName: x.member_name ?? '',
      memberPartyId,
      description: typeof x.metadata['description'] === 'string' ? x.metadata['description'] : kind === 'allowance' ? 'Allowance' : kind === 'reversal' ? 'Reversal' : 'Fee',
      amount: money(minor, currency),
    };
  });
  const sum = (f: (r: ExportRow) => boolean) => rows.filter(f).reduce((a, r) => a + r.amount.minor, 0n);
  const allowancesOut = sum((x) => x.amount.minor < 0n);
  const feesIn = sum((x) => x.amount.minor > 0n);
  return { institutionId, month, currency, rows, totals: { allowancesOut: money(allowancesOut, currency), feesIn: money(feesIn, currency), net: money(allowancesOut + feesIn, currency) } };
}

export const HEADERS = ['date', 'journal_id', 'kind', 'member_name', 'member_party_id', 'description', 'amount_minor', 'currency', 'amount'] as const;

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

export function toCsv(e: MonthlyExport): string {
  const esc = (v: string) => {
    const s = neutralise(v);
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

export function toXlsx(e: MonthlyExport): Uint8Array {
  const rows = cells(e)
    .map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${xml(neutralise(v))}</t></is></c>`).join('')}</row>`)
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

/** A zip with stored entries (method 0): enough for Excel, and nothing to get wrong about deflate. */
export function zipStored(entries: readonly (readonly [string, string])[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, text] of entries) {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length)];
    const local = new Uint8Array([...u32(0x04034b50), ...common, ...u16(0), ...nameB, ...data]);
    const central = new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameB]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const out = new Uint8Array(offset + cdSize + end.length);
  let pos = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** Reads a stored zip back (tests, and anyone checking what was exported). */
export function unzipStored(bytes: Uint8Array): Map<string, string> {
  const dec = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let pos = 0;
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const start = pos + 30 + nameLen + extraLen;
    out.set(name, dec.decode(bytes.subarray(start, start + size)));
    pos = start + size;
  }
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

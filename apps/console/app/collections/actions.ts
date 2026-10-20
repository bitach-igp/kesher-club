'use server';
// I08 server action (T-0611): the month's export as the signed-in staff member. The envelope goes to the
// browser, which turns it back into the file's exact bytes.
import type { Result } from '../../src/api.ts';
import type { ExportFile } from '../../src/collections.ts';
import { asStaff } from '../../src/request.ts';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function exportMonth(month: string, format: 'csv' | 'xlsx'): Promise<Result<ExportFile>> {
  if (!MONTH.test(month) || (format !== 'csv' && format !== 'xlsx')) return { ok: false, code: 'VALIDATION_FAILED' };
  return asStaff((api, id) => api.exportCollections(id, month, format));
}

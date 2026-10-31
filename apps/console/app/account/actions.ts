'use server';
// I10 server action (T-0646): the month's statement file as the signed-in finance member or admin.
import type { Result } from '../../src/api.ts';
import type { ExportFile } from '../../src/collections.ts';
import { asStaff } from '../../src/request.ts';

export async function exportStatement(month: string, currency: 'ILS' | 'USD', format: 'csv' | 'xlsx'): Promise<Result<Pick<ExportFile, 'filename' | 'contentType' | 'base64' | 'rows'>>> {
  return asStaff((api, id) => api.exportStatement(id, month, currency, format));
}

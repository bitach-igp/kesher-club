'use server';
// I05 server action (T-0640): send the roster CSV to importRoster as the signed-in staff member, with the browser's key.
import type { Result } from '../../../src/api.ts';
import { asStaff } from '../../../src/request.ts';
import type { RosterImportRequest, RosterImportResult } from '../../../src/roster-import.ts';

export async function importRoster(body: RosterImportRequest, idempotencyKey: string): Promise<Result<RosterImportResult>> {
  return asStaff((api, id) => api.importRoster(id, body, idempotencyKey));
}

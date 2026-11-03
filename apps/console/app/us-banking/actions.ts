'use server';
// US bank account server actions (T-0651): each acts as the signed-in staff member for their own institution (the step-up relay is in app/step-up.ts).
import type { Result } from '../../src/api.ts';
import { asStaff } from '../../src/request.ts';
import type { Money, StartInput, UsBankingLink, UsFunding, UsFundingQuote } from '../../src/us-banking.ts';

export async function startUsBanking(body: StartInput, idempotencyKey: string): Promise<Result<UsBankingLink>> {
  // The bank's application form is opened for the applicant's address: the browser's is forwarded.
  return asStaff((api, id) => api.startUsBanking(id, body, idempotencyKey), { forwardIp: true });
}
export async function quoteUsFunding(amount: Money): Promise<Result<UsFundingQuote>> {
  return asStaff((api, id) => api.quoteUsFunding(id, amount));
}
export async function requestUsFunding(quoteId: string, idempotencyKey: string): Promise<Result<UsFunding>> {
  return asStaff((api, id) => api.requestUsFunding(id, quoteId, idempotencyKey));
}
export async function approveUsFunding(requestId: string): Promise<Result<UsFunding>> {
  return asStaff((api, id) => api.approveUsFunding(id, requestId));
}
export async function cancelUsFunding(requestId: string): Promise<Result<UsFunding>> {
  return asStaff((api, id) => api.cancelUsFunding(id, requestId));
}

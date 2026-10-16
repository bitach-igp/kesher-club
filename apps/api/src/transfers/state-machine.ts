// Transfer state machine (T-0205). States mirror contracts/openapi.yaml `Transfer.state`.
//   created → submitted → pending → settled
//                       ↘ pending_hold → (release) pending | (cancel) cancelled | (expire) pending
//   submitted | pending → failed
//   settled → reversed
// Anything else is refused: the workflow is the only writer and it never skips a step.
import { DomainError } from '@kesher/domain';

export type TransferState = 'created' | 'submitted' | 'pending' | 'pending_hold' | 'settled' | 'failed' | 'reversed' | 'cancelled';
export type TransferEvent = 'submit' | 'hold' | 'release_hold' | 'cancel' | 'settle' | 'fail' | 'reverse';

const TRANSITIONS: Readonly<Record<TransferState, Partial<Record<TransferEvent, TransferState>>>> = {
  created: { submit: 'submitted', cancel: 'cancelled', fail: 'failed' },
  submitted: { hold: 'pending_hold', settle: 'settled', fail: 'failed' },
  pending: { settle: 'settled', fail: 'failed' },
  pending_hold: { release_hold: 'pending', cancel: 'cancelled', fail: 'failed' },
  settled: { reverse: 'reversed' },
  failed: {},
  reversed: {},
  cancelled: {},
};

export const TERMINAL_STATES: ReadonlySet<TransferState> = new Set(['settled', 'failed', 'reversed', 'cancelled']);

export function next(from: TransferState, event: TransferEvent): TransferState {
  const to = TRANSITIONS[from][event];
  if (!to) throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot ${event} a transfer that is ${from}`);
  return to;
}

export const canTransition = (from: TransferState, event: TransferEvent): boolean => TRANSITIONS[from][event] !== undefined;

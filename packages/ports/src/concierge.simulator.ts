// ConciergePort simulator. Fixture: summary starting "OUTAGE" -> PROVIDER_UNAVAILABLE. Emergency and
// medical cases have a 5-minute callback SLA, everything else 60 minutes. `resolve()` is a panel hook.
import { type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { ConciergeError, type CaseKind, type CaseMessage, type ConciergeCase, type ConciergePort } from './concierge.ts';

const SLA: Record<CaseKind, number> = { emergency: 5, medical: 5, lost_card: 15, travel: 60, help: 60 };

export class ConciergeSimulator implements ConciergePort {
  private readonly cases = new Map<string, ConciergeCase & { messages: CaseMessage[] }>();
  private readonly idem = new IdempotencyStore<unknown>();
  private readonly ids = new Sequence('case');
  private readonly msgIds = new Sequence('msg');

  constructor(readonly clock: Clock = fixedClock()) {}

  async openCase(input: { kind: CaseKind; memberId: string; summary: string; locale: 'en' | 'he'; phone?: string }, key: string): Promise<ConciergeCase> {
    if (input.summary.startsWith('OUTAGE')) throw new ConciergeError('PROVIDER_UNAVAILABLE', 'Simulated partner outage');
    if (!input.summary.trim()) throw new ConciergeError('VALIDATION_FAILED', 'Summary required');
    return (await this.idem.run(key, async () => {
      const caseId = this.ids.next();
      const c = {
        caseId,
        kind: input.kind,
        memberId: input.memberId,
        status: 'open' as const,
        externalRef: `PARTNER-${caseId.toUpperCase()}`,
        openedAt: this.clock.now().toISOString(),
        callbackSlaMinutes: SLA[input.kind],
        messages: [{ messageId: this.msgIds.next(), from: 'member' as const, text: input.summary, at: this.clock.now().toISOString() }],
      };
      this.cases.set(caseId, c);
      const { messages: _m, ...out } = c;
      return out;
    })) as ConciergeCase;
  }

  async addMessage(caseId: string, text: string, key: string): Promise<CaseMessage> {
    return (await this.idem.run(key, async () => {
      const c = this.must(caseId);
      if (c.status === 'closed') throw new ConciergeError('CASE_CLOSED', 'Case is closed');
      const m: CaseMessage = { messageId: this.msgIds.next(), from: 'member', text, at: this.clock.now().toISOString() };
      c.messages.push(m);
      if (c.status === 'open') c.status = 'in_progress';
      return m;
    })) as CaseMessage;
  }

  async getCase(caseId: string): Promise<ConciergeCase & { messages: readonly CaseMessage[] }> {
    const c = this.must(caseId);
    return { ...c, messages: c.messages.map((m) => ({ ...m })) };
  }

  /** Control-panel hook: the partner replies and resolves. */
  resolve(caseId: string, reply: string): void {
    const c = this.must(caseId);
    c.messages.push({ messageId: this.msgIds.next(), from: 'partner', text: reply, at: this.clock.now().toISOString() });
    c.status = 'resolved';
  }

  private must(id: string) {
    const c = this.cases.get(id);
    if (!c) throw new ConciergeError('UNKNOWN_CASE', id);
    return c;
  }
}

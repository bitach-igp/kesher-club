// Concierge adapters (T-0730): a partner case API (flag concierge.partner) and the day-one email
// bridge that opens cases by email through a NotifyPort. Case text is untrusted data either way.
import { createHash } from 'node:crypto';
import { ConciergeError, IdempotencyStore, type CaseKind, type CaseMessage, type ConciergeCase, type ConciergePort, type NotifyPort } from '@kesher/ports';

const SLA: Record<CaseKind, number> = { emergency: 5, medical: 5, lost_card: 15, travel: 60, help: 60 };

export interface PartnerConciergeOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

/** Generic partner case API: POST /cases, POST /cases/{id}/messages, GET /cases/{id}. */
export class PartnerConciergeAdapter implements ConciergePort {
  private readonly fetchImpl: typeof fetch;
  private readonly idem = new IdempotencyStore<unknown>();

  constructor(private readonly opts: PartnerConciergeOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async openCase(input: { kind: CaseKind; memberId: string; summary: string; locale: 'en' | 'he'; phone?: string }, key: string): Promise<ConciergeCase> {
    if (!input.summary.trim()) throw new ConciergeError('VALIDATION_FAILED', 'Summary required');
    return (await this.idem.run(key, async () => {
      const r = await this.call('POST', '/cases', { kind: input.kind, member_ref: input.memberId, summary: input.summary, locale: input.locale, phone: input.phone, priority: SLA[input.kind] <= 5 ? 'urgent' : 'normal', idempotency_key: key });
      return this.toCase(r as PartnerCase, input.memberId);
    })) as ConciergeCase;
  }

  async addMessage(caseId: string, text: string, key: string): Promise<CaseMessage> {
    return (await this.idem.run(key, async () => {
      const r = (await this.call('POST', `/cases/${encodeURIComponent(caseId)}/messages`, { text, idempotency_key: key })) as PartnerMessage;
      return { messageId: r.id, from: 'member' as const, text: r.text, at: r.created_at };
    })) as CaseMessage;
  }

  async getCase(caseId: string): Promise<ConciergeCase & { messages: readonly CaseMessage[] }> {
    const r = (await this.call('GET', `/cases/${encodeURIComponent(caseId)}`)) as PartnerCase & { messages: PartnerMessage[] };
    return { ...this.toCase(r, r.member_ref), messages: (r.messages ?? []).map((m) => ({ messageId: m.id, from: m.author === 'agent' ? 'partner' : 'member', text: m.text, at: m.created_at })) };
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw new ConciergeError('PROVIDER_UNAVAILABLE', 'Partner API unreachable');
    }
    if (res.status === 404) throw new ConciergeError('UNKNOWN_CASE', 'Case not found');
    if (res.status === 409) throw new ConciergeError('CASE_CLOSED', 'Case is closed');
    if (res.status === 429 || res.status >= 500) throw new ConciergeError('PROVIDER_UNAVAILABLE', `Partner API returned ${res.status}`);
    if (!res.ok) throw new ConciergeError('VALIDATION_FAILED', `Partner API rejected the request (${res.status})`);
    return res.json();
  }

  private toCase(r: PartnerCase, memberId: string): ConciergeCase {
    const status = r.status === 'new' ? 'open' : r.status === 'working' ? 'in_progress' : r.status === 'solved' ? 'resolved' : r.status === 'closed' ? 'closed' : 'open';
    return { caseId: r.id, kind: r.kind, memberId, status, externalRef: r.reference ?? r.id, openedAt: r.created_at, callbackSlaMinutes: SLA[r.kind] };
  }
}

interface PartnerCase {
  id: string;
  kind: CaseKind;
  status: string;
  reference?: string;
  created_at: string;
  member_ref: string;
}
interface PartnerMessage {
  id: string;
  text: string;
  author: 'member' | 'agent';
  created_at: string;
}

/** Day-one fallback: one email per case to the help desk; local state only (no partner to poll). */
export class EmailBridgeConciergeAdapter implements ConciergePort {
  private readonly cases = new Map<string, ConciergeCase & { messages: CaseMessage[] }>();
  private readonly idem = new IdempotencyStore<unknown>();

  constructor(
    private readonly notify: NotifyPort,
    private readonly helpDeskEmail: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async openCase(input: { kind: CaseKind; memberId: string; summary: string; locale: 'en' | 'he'; phone?: string }, key: string): Promise<ConciergeCase> {
    if (!input.summary.trim()) throw new ConciergeError('VALIDATION_FAILED', 'Summary required');
    return (await this.idem.run(key, async () => {
      const caseId = `case_${createHash('sha256').update(key).digest('base64url').slice(0, 12)}`;
      const now = this.clock().toISOString();
      try {
        await this.notify.send({ channel: 'email', to: this.helpDeskEmail, template: input.kind === 'emergency' || input.kind === 'medical' ? 'concierge.emergency' : 'concierge.case', locale: input.locale, data: { caseId, kind: input.kind, memberRef: input.memberId, summary: input.summary, phone: input.phone ?? '' }, category: input.kind === 'emergency' || input.kind === 'medical' ? 'emergency' : 'service' }, `${key}:email`);
      } catch {
        throw new ConciergeError('PROVIDER_UNAVAILABLE', 'Help desk email could not be sent');
      }
      const c = { caseId, kind: input.kind, memberId: input.memberId, status: 'open' as const, externalRef: `EMAIL-${caseId}`, openedAt: now, callbackSlaMinutes: SLA[input.kind], messages: [{ messageId: `${caseId}-1`, from: 'member' as const, text: input.summary, at: now }] };
      this.cases.set(caseId, c);
      const { messages: _m, ...out } = c;
      return out;
    })) as ConciergeCase;
  }

  async addMessage(caseId: string, text: string, key: string): Promise<CaseMessage> {
    return (await this.idem.run(key, async () => {
      const c = this.cases.get(caseId);
      if (!c) throw new ConciergeError('UNKNOWN_CASE', 'Case not found');
      if (c.status === 'closed') throw new ConciergeError('CASE_CLOSED', 'Case is closed');
      const m: CaseMessage = { messageId: `${caseId}-${c.messages.length + 1}`, from: 'member', text, at: this.clock().toISOString() };
      await this.notify.send({ channel: 'email', to: this.helpDeskEmail, template: 'concierge.message', locale: 'en', data: { caseId, text }, category: 'service' }, `${key}:email`).catch(() => undefined);
      c.messages.push(m);
      if (c.status === 'open') c.status = 'in_progress';
      return m;
    })) as CaseMessage;
  }

  async getCase(caseId: string): Promise<ConciergeCase & { messages: readonly CaseMessage[] }> {
    const c = this.cases.get(caseId);
    if (!c) throw new ConciergeError('UNKNOWN_CASE', 'Case not found');
    return { ...c, messages: [...c.messages] };
  }
}

// TST-CMP-002 (REQ-CMP-002): complaints carry SLA timers (acknowledge 2 business days, resolve 15)
// and export for the bank. Given an aged complaint, then it shows red at day 13.
import { describe, expect, it } from 'vitest';
import type { Complaint } from '../data/types.ts';
import { memoryAdminData } from '../data/memory.ts';
import { ageHours, queue } from './alerts.ts';
import { addBusinessDays, businessDaysBetween, complaintSla, exportForBank, sortBySla } from './sla.ts';

// 2026-11-02 is a Monday.
const MON = new Date('2026-11-02T09:00:00Z');
const base: Complaint = { id: 'c', partyId: 'p', channel: 'app', category: 'fees', summary: 'x', openedAt: MON.toISOString(), status: 'open' };
const at = (businessDays: number) => addBusinessDays(MON, businessDays);

describe('complaint SLA timers (TST-CMP-002)', () => {
  it('counts business days, skipping weekends and holidays', () => {
    expect(businessDaysBetween(MON, new Date('2026-11-06T18:00:00Z'))).toBe(4); // Tue..Fri
    expect(businessDaysBetween(MON, new Date('2026-11-09T09:00:00Z'))).toBe(5); // + Mon, weekend skipped
    expect(businessDaysBetween(MON, new Date('2026-11-09T09:00:00Z'), { holidays: new Set(['2026-11-05']) })).toBe(4);
    expect(addBusinessDays(MON, 2).toISOString()).toBe('2026-11-04T23:59:59.999Z');
    expect(addBusinessDays(new Date('2026-11-06T09:00:00Z'), 1).toISOString()).toBe('2026-11-09T23:59:59.999Z');
  });

  it('acknowledge within 2 business days, resolve within 15; green, amber at 10, red at 13, breached after 15', () => {
    expect(complaintSla(base, new Date('2026-11-03T09:00:00Z'))).toMatchObject({ businessDaysOpen: 1, ackBreached: false, resolveColour: 'green', ackDue: '2026-11-04T23:59:59.999Z' });
    expect(complaintSla(base, new Date('2026-11-05T09:00:00Z'))).toMatchObject({ businessDaysOpen: 3, ackBreached: true });
    expect(complaintSla({ ...base, acknowledgedAt: '2026-11-04T10:00:00Z', status: 'acknowledged' }, at(9))).toMatchObject({ ackMet: true, ackBreached: false, resolveColour: 'green' });
    expect(complaintSla({ ...base, acknowledgedAt: '2026-11-05T10:00:00Z', status: 'acknowledged' }, at(10))).toMatchObject({ ackMet: false, ackBreached: true, resolveColour: 'amber', daysToResolveDeadline: 5 });
    expect(complaintSla(base, at(12)).resolveColour).toBe('amber');
    expect(complaintSla(base, at(13)).resolveColour).toBe('red');
    expect(complaintSla(base, at(15)).resolveColour).toBe('red');
    expect(complaintSla(base, at(16)).resolveColour).toBe('breached');
    expect(complaintSla({ ...base, status: 'resolved', resolvedAt: at(4).toISOString() }, at(20))).toMatchObject({ resolveColour: 'closed', businessDaysOpen: 4 });
  });

  it('the queue puts breached and red complaints first, oldest first within a colour', () => {
    const rows = [
      { c: { ...base, id: 'green', openedAt: at(-1).toISOString() } },
      { c: { ...base, id: 'red-old', openedAt: addBusinessDays(MON, -14).toISOString() } },
      { c: { ...base, id: 'red-new', openedAt: addBusinessDays(MON, -13).toISOString() } },
      { c: { ...base, id: 'done', status: 'resolved' as const, resolvedAt: MON.toISOString(), openedAt: addBusinessDays(MON, -30).toISOString() } },
    ].map(({ c }) => ({ c, sla: complaintSla(c, MON) }));
    expect(sortBySla(rows).map((r) => r.c.id)).toEqual(['red-old', 'red-new', 'green', 'done']);
  });

  it('exports every complaint with both clocks for the bank, with member text escaped as data', () => {
    const csv = exportForBank([{ ...base, summary: '=HYPERLINK("x"), "quoted"\nline' }, { ...base, id: 'c2', status: 'resolved', resolvedAt: at(3).toISOString(), acknowledgedAt: at(1).toISOString(), owner: 'admin:cmp-1', escalatedToBank: true }], at(14));
    const [header, row1, row2] = csv.split('\r\n');
    expect(header).toBe('id,party_id,channel,category,summary,opened_at,acknowledged_at,ack_due,ack_met,resolved_at,resolve_due,status,business_days_open,sla_colour,owner,escalated_to_bank');
    expect(row1).toContain('"\'=HYPERLINK(""x""), ""quoted""\nline"');
    expect(row1).toContain(',red,,false');
    expect(row2).toContain(',resolved,3,closed,admin:cmp-1,true');
  });

  it('acknowledge and resolve through the store stamp the admin and the time', async () => {
    const data = memoryAdminData();
    const by = { subject: 'admin:cmp-1', roles: ['compliance'] };
    const acked = await data.acknowledgeComplaint('cmp-1', by, MON);
    expect(acked).toMatchObject({ status: 'acknowledged', owner: 'admin:cmp-1', acknowledgedAt: MON.toISOString() });
    await expect(data.acknowledgeComplaint('cmp-1', by, MON)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await data.resolveComplaint('cmp-1', by, MON)).status).toBe('resolved');
    expect((await data.listComplaints()).find((c) => c.id === 'cmp-2')).toMatchObject({ status: 'acknowledged' });
  });

  it('the alert queue is severity first then age, and decisions are audited', async () => {
    const data = memoryAdminData();
    const q = queue(await data.listAlerts());
    expect(q.map((a) => a.id)).toEqual(['alert-3', 'alert-1', 'alert-2']);
    expect(ageHours(q[0]!, MON)).toBe(91);
    await data.decideAlert('alert-1', 'escalated', { subject: 'admin:cmp-1', roles: ['compliance'] }, 'SAR drafted', MON);
    expect(queue(await data.listAlerts()).map((a) => a.id)).toEqual(['alert-3', 'alert-2']);
    expect((await data.auditLog())[0]).toMatchObject({ action: 'alert.escalated', subject: 'alert-1', detail: 'SAR drafted' });
  });
});

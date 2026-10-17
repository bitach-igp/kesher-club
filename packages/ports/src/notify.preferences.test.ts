// TST-NOT-001: notifications follow per-user channel preferences and quiet hours (23:00–07:00
// IL), except security and emergency messages. Given 23:30, a marketing push is deferred to 07:00.
import { describe, expect, it } from 'vitest';
import { NotifySimulator } from './notify.simulator.ts';
import { DEFAULT_PREFERENCES, NotifyService, localMinutes, quietWindow, type Preferences } from './notify.preferences.ts';
import type { Notification } from './notify.ts';

const push = (category: Notification['category'], template = 'promo'): Notification => ({ channel: 'push', to: 'ExponentPushToken[x]', template, locale: 'en', data: {}, category });
const at = (iso: string) => new Date(iso);

function service(prefs: Partial<Preferences> = {}, start = '2026-11-01T21:30:00Z') {
  let t = Date.parse(start); // 23:30 Israel (UTC+2 in November)
  const sim = new NotifySimulator();
  const svc = new NotifyService(sim, { get: async () => ({ ...DEFAULT_PREFERENCES, ...prefs }) }, () => new Date(t));
  return { sim, svc, advance: (ms: number) => void (t += ms) };
}

describe('quiet hours (REQ-NOT-001)', () => {
  it('maps instants to Israel wall-clock minutes across DST', () => {
    expect(localMinutes(at('2026-11-01T21:30:00Z'), 'Asia/Jerusalem')).toBe(23 * 60 + 30); // IST
    expect(localMinutes(at('2026-07-01T21:30:00Z'), 'Asia/Jerusalem')).toBe(0 * 60 + 30); // IDT
  });

  it('a wrapping window 23:00–07:00 is quiet at 23:30 and 06:59, open at 07:00 and 22:59', () => {
    const q = (iso: string) => quietWindow(at(iso), DEFAULT_PREFERENCES);
    expect(q('2026-11-01T21:30:00Z').quiet).toBe(true); // 23:30
    expect(q('2026-11-02T04:59:00Z').quiet).toBe(true); // 06:59
    expect(q('2026-11-02T05:00:00Z').quiet).toBe(false); // 07:00
    expect(q('2026-11-01T20:59:00Z').quiet).toBe(false); // 22:59
    expect(q('2026-11-01T21:30:00Z').releaseAt?.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // 07:00 IL
  });
});

describe('NotifyService (REQ-NOT-001)', () => {
  it('at 23:30 a marketing push is deferred to 07:00 and goes out on flush', async () => {
    const { sim, svc, advance } = service();
    const r = await svc.send('p1', push('marketing'), 'k1');
    expect(r).toEqual({ action: 'deferred', releaseAt: '2026-11-02T05:00:00.000Z' });
    expect(sim.sent.length).toBe(0);
    expect(await svc.flush()).toBe(0);
    advance(7.5 * 3_600_000);
    expect(await svc.flush()).toBe(1);
    expect(sim.sent[0]?.template).toBe('promo');
    expect(svc.pending()).toBe(0);
  });

  it('security and emergency messages go out at once, even at 23:30 and even if the user opted out of everything else', async () => {
    const { sim, svc } = service({ optOut: ['marketing', 'money', 'service'], channels: { security: ['email'] } });
    expect((await svc.send('p1', push('security', 'new_device'), 'k2')).action).toBe('sent');
    expect((await svc.send('p1', push('emergency', 'sos'), 'k3')).action).toBe('sent');
    expect(sim.sent.map((n) => n.template)).toEqual(['new_device', 'sos']);
  });

  it('honours channel preferences and opt-outs per category', async () => {
    const { sim, svc } = service({ channels: { money: ['email'] }, optOut: ['marketing'] }, '2026-11-01T10:00:00Z');
    expect(await svc.send('p1', push('money'), 'k4')).toEqual({ action: 'suppressed', reason: 'channel_not_allowed' });
    expect((await svc.send('p1', { ...push('money'), channel: 'email', to: 'a@example.com' }, 'k5')).action).toBe('sent');
    expect(await svc.send('p1', push('marketing'), 'k6')).toEqual({ action: 'suppressed', reason: 'opted_out' });
    expect((await svc.send('p1', push('service'), 'k7')).action).toBe('sent');
    expect(sim.sent.length).toBe(2);
  });

  it('users without stored preferences get the defaults (Israel quiet hours, all channels)', async () => {
    const sim = new NotifySimulator();
    const svc = new NotifyService(sim, { get: async () => undefined }, () => at('2026-11-01T10:00:00Z'));
    expect((await svc.send('p2', push('marketing'), 'k8')).action).toBe('sent');
  });

  it('a user in New York with their own quiet hours is judged in their zone', async () => {
    const { svc } = service({ timeZone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' } }, '2026-11-01T21:30:00Z'); // 16:30 in New York
    expect((await svc.send('p1', push('marketing'), 'k9')).action).toBe('sent');
  });
});

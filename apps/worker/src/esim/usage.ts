// eSIM usage polling (T-0712, REQ-ESIM-003): low data (under 20% left) and expiry (3 days)
// trigger one notification each per eSIM, through the NotifyPort with the member's push token.
// Given usage 81%, one push. Polling is per fulfilled order; each threshold fires once.
import { uuidv7 } from '@kesher/domain';
import type { EsimPort, Market, NotifyPort } from '@kesher/ports';
import type { Database } from '@kesher/api/db';

export const LOW_DATA_THRESHOLD_PCT = 20;
export const EXPIRY_WARNING_DAYS = 3;

export interface UsagePollReport {
  polled: number;
  lowData: number;
  expiring: number;
  errors: number;
}

export interface PushTokenLookup {
  (memberPartyId: string): Promise<string | undefined>;
}

export class EsimUsagePoller {
  private readonly db: Database;
  private readonly esim: (provider: string) => EsimPort;
  private readonly notify: NotifyPort;
  private readonly pushToken: PushTokenLookup;
  /** Only this market's orders: another market's worker asks its own provider about its own (T-0028). */
  private readonly market: Market;
  constructor(
    db: Database,
    esim: (provider: string) => EsimPort,
    notify: NotifyPort,
    pushToken: PushTokenLookup,
    market: Market,
  ) {
    this.db = db;
    this.esim = esim;
    this.notify = notify;
    this.pushToken = pushToken;
    this.market = market;
  }

  async poll(now: Date): Promise<UsagePollReport> {
    const orders = await this.db.query<{ id: string; member_party_id: string; provider: string; fulfilment: { iccid: string; expiresAt?: string } }>(
      `select id, member_party_id, provider, fulfilment from addons.addon_order where kind = 'esim' and state = 'fulfilled' and fulfilment ? 'iccid' and (fulfilment->>'expiresAt' is null or (fulfilment->>'expiresAt')::timestamptz > $1) and market = $2`,
      [new Date(now.getTime() - 86_400_000), this.market],
    );
    const report: UsagePollReport = { polled: 0, lowData: 0, expiring: 0, errors: 0 };
    for (const o of orders.rows) {
      report.polled += 1;
      try {
        const u = await this.esim(o.provider).getUsage(o.fulfilment.iccid);
        const leftPct = u.totalMb === 0 ? 0 : Math.floor(((u.totalMb - u.usedMb) / u.totalMb) * 100);
        const daysLeft = (Date.parse(u.expiresAt) - now.getTime()) / 86_400_000;
        await this.db.query(`update addons.addon_order set fulfilment = fulfilment || $2::jsonb, updated_at = $3 where id = $1`, [o.id, JSON.stringify({ usedMb: u.usedMb, totalMb: u.totalMb, expiresAt: u.expiresAt, leftPct, polledAt: now.toISOString() }), now]);
        if (leftPct < LOW_DATA_THRESHOLD_PCT && (await this.fireOnce(o.id, 'low_data', now))) {
          await this.push(o.member_party_id, 'esim.low_data', { leftPct: String(leftPct), iccidLast4: o.fulfilment.iccid.slice(-4) }, `esim:${o.id}:low_data`);
          report.lowData += 1;
        }
        if (daysLeft <= EXPIRY_WARNING_DAYS && daysLeft > 0 && (await this.fireOnce(o.id, 'expiring', now))) {
          await this.push(o.member_party_id, 'esim.expiring', { days: String(Math.ceil(daysLeft)), iccidLast4: o.fulfilment.iccid.slice(-4) }, `esim:${o.id}:expiring`);
          report.expiring += 1;
        }
      } catch {
        report.errors += 1; // provider hiccup: next poll retries; never alert the member on our error
      }
    }
    return report;
  }

  /** Records that a threshold fired for an order; false when it already had. */
  private async fireOnce(orderId: string, kind: 'low_data' | 'expiring', now: Date): Promise<boolean> {
    const r = await this.db.query(`insert into addons.addon_order_event (order_id, from_state, to_state, reason, at) select $1, 'fulfilled', 'fulfilled', $2, $3 where not exists (select 1 from addons.addon_order_event where order_id = $1 and reason = $2)`, [orderId, `notify:${kind}`, now]);
    return r.rowCount > 0;
  }

  private async push(memberPartyId: string, template: string, data: Record<string, string>, key: string): Promise<void> {
    const to = await this.pushToken(memberPartyId);
    if (!to) return;
    await this.notify.send({ channel: 'push', to, template, locale: 'en', data, category: 'service' }, `${key}:${uuidv7()}`);
  }
}

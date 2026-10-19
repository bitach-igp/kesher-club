// EsimPort (Tab 1 capability ports; REQ-ESIM-001..003). Vendor adapters (Airalo, Holafly)
// implement this interface in packages/adapters and must pass esimContract().

import type { Money } from '@kesher/domain';

export interface EsimPackage {
  sku: string;
  country: string;
  dataGb: number;
  days: number;
  cost: Money;
}

export interface EsimOrder {
  orderId: string;
  sku: string;
  iccid: string;
  /** iOS 17.4+ universal link or Android link; QR is derived from the LPA string. */
  installUrl: string;
  lpa: string;
}

export interface EsimUsage {
  iccid: string;
  usedMb: number;
  totalMb: number;
  expiresAt: string;
}

export interface EsimPort {
  listPackages(country: string): Promise<EsimPackage[]>;
  /** Idempotent by key: the same key returns the same order. */
  order(sku: string, idempotencyKey: string): Promise<EsimOrder>;
  topUp(iccid: string, sku: string, idempotencyKey: string): Promise<EsimUsage>;
  getUsage(iccid: string): Promise<EsimUsage>;
}

export class EsimError extends Error {
  readonly code: 'UNKNOWN_SKU' | 'UNKNOWN_ICCID' | 'PROVIDER_UNAVAILABLE';
  constructor(code: 'UNKNOWN_SKU' | 'UNKNOWN_ICCID' | 'PROVIDER_UNAVAILABLE', msg: string) {
    super(msg);
    this.code = code;
    this.name = 'EsimError';
  }
}

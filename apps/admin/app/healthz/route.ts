// Load balancer health check (T-0917). The proxy's matcher leaves /healthz alone, so the ALB reaches it
// from inside the VPC without the VPN or SSO. It answers 200 only when the config loads: a task started
// with a missing or bad setting never turns healthy, and ECS rolls the deploy back. The body names no
// key and no value.
import { NextResponse } from 'next/server';
import { getConfig } from '../../src/config.ts';

export function GET(): NextResponse {
  try {
    getConfig();
    return NextResponse.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ status: 'misconfigured' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

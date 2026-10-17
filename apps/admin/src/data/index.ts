// Which AdminData binding this process uses (ADR-013): `api` everywhere, `memory` only in local
// and preview. Chosen once from config; missing config crashes on boot like everything else.
import { getConfig } from '../config.ts';
import { currentActor } from '../ui/actor.ts';
import { staffSigner } from '../auth/staff-token.ts';
import { httpAdminData } from './http.ts';
import { memoryAdminData } from './memory.ts';
import type { AdminData } from './types.ts';

let singleton: Promise<AdminData> | undefined;

export function getAdminData(): Promise<AdminData> {
  singleton ??= build();
  return singleton;
}

async function build(): Promise<AdminData> {
  const cfg = getConfig();
  if (cfg.ADMIN_DATA === 'memory') return memoryAdminData();
  const signer = await staffSigner(cfg.ADMIN_API_SIGNING_KEY, cfg.ADMIN_API_SIGNING_KID);
  return httpAdminData({ baseUrl: cfg.ADMIN_API_URL, signer, actor: currentActor });
}

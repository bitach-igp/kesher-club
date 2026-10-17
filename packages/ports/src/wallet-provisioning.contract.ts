// WalletProvisioningPort contract (TST-CRD-006/007 at the port layer).
import { describe, expect, it } from 'vitest';
import type { WalletProvisioningPort } from './wallet-provisioning.ts';

export interface WalletProvisioningContractOptions {
  cardId: string;
  appleClientData: Record<string, string>;
  deletedTokenWebhook: (port: WalletProvisioningPort, tokenId: string) => Promise<{ headers: Record<string, string>; rawBody: string }>;
  outageDeviceId?: string;
}

export function walletProvisioningContract(name: string, make: () => WalletProvisioningPort, opts: WalletProvisioningContractOptions): void {
  describe(`WalletProvisioningPort contract: ${name}`, () => {
    it('push-provisions idempotently and the token then appears on the card (REQ-CRD-006)', async () => {
      const port = make();
      const input = { cardId: opts.cardId, wallet: 'apple' as const, deviceId: 'iphone-1', clientData: opts.appleClientData };
      const a = await port.pushProvision(input, 'pp-1');
      const b = await port.pushProvision(input, 'pp-1');
      expect(b).toEqual(a);
      expect(a.encryptedPassData).toBeTruthy();
      expect(a.activationData).toBeTruthy();
      expect(a.ephemeralPublicKey).toBeTruthy();
      const tokens = await port.listTokens(opts.cardId);
      expect(tokens.filter((t) => t.deviceId === 'iphone-1' && t.wallet === 'apple').length).toBe(1);
    });

    it('rejects Apple provisioning without the iOS sheet data', async () => {
      await expect(make().pushProvision({ cardId: opts.cardId, wallet: 'apple', deviceId: 'd', clientData: {} }, 'pp-2')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('freeze cascades to every token (REQ-CRD-004)', async () => {
      const port = make();
      await port.pushProvision({ cardId: opts.cardId, wallet: 'google', deviceId: 'pixel-1', clientData: {} }, 'pp-3');
      await port.pushProvision({ cardId: opts.cardId, wallet: 'apple', deviceId: 'iphone-2', clientData: opts.appleClientData }, 'pp-4');
      const suspended = await port.setTokensStatus(opts.cardId, 'suspended', 'st-1');
      expect(suspended.every((t) => t.status === 'suspended')).toBe(true);
      const resumed = await port.setTokensStatus(opts.cardId, 'active', 'st-2');
      expect(resumed.every((t) => t.status === 'active')).toBe(true);
    });

    it('token lifecycle webhooks update the row and are deduped (REQ-CRD-007)', async () => {
      const port = make();
      await port.pushProvision({ cardId: opts.cardId, wallet: 'google', deviceId: 'pixel-2', clientData: {} }, 'pp-5');
      const [token] = await port.listTokens(opts.cardId);
      const hook = await opts.deletedTokenWebhook(port, token!.tokenId);
      const e1 = await port.parseTokenEvent(hook.headers, hook.rawBody);
      const e2 = await port.parseTokenEvent(hook.headers, hook.rawBody);
      expect(e1.token.status).toBe('deleted');
      expect(e2).toEqual(e1);
      await expect(port.parseTokenEvent({ 'x-sim-signature': 'forged', 'x-signature': 'forged' }, hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    if (opts.outageDeviceId) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().pushProvision({ cardId: opts.cardId, wallet: 'google', deviceId: opts.outageDeviceId!, clientData: {} }, 'pp-o')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}

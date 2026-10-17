// WalletProvisioningPort simulator. A push provision immediately creates an active token (the real
// flow completes via a token.created webhook; `tokenEvent()` builds one). Fixture: deviceId
// "dev_outage" -> PROVIDER_UNAVAILABLE.
import { type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { WalletProvisioningError, type CardToken, type ProvisioningPayload, type TokenStatus, type WalletKind, type WalletProvisioningPort } from './wallet-provisioning.ts';

export class WalletProvisioningSimulator implements WalletProvisioningPort {
  private readonly tokens = new Map<string, CardToken>();
  private readonly idem = new IdempotencyStore<unknown>();
  private readonly events = new Map<string, { eventId: string; token: CardToken }>();
  private readonly ids = new Sequence('tok');
  private readonly evIds = new Sequence('evt');

  constructor(
    readonly clock: Clock = fixedClock(),
    private readonly knownCards: (cardId: string) => boolean = () => true,
  ) {}

  async pushProvision(input: { cardId: string; wallet: WalletKind; deviceId: string; clientData: Record<string, string> }, key: string): Promise<ProvisioningPayload> {
    if (input.deviceId === 'dev_outage') throw new WalletProvisioningError('PROVIDER_UNAVAILABLE', 'Simulated processor outage');
    if (!this.knownCards(input.cardId)) throw new WalletProvisioningError('UNKNOWN_CARD', input.cardId);
    if (input.wallet === 'apple' && !(input.clientData.nonce && input.clientData.nonceSignature && input.clientData.certificates)) {
      throw new WalletProvisioningError('VALIDATION_FAILED', 'Apple provisioning needs certificates, nonce and nonceSignature');
    }
    return (await this.idem.run(key, async () => {
      const token: CardToken = { tokenId: this.ids.next(), cardId: input.cardId, wallet: input.wallet, status: 'active', deviceId: input.deviceId, updatedAt: this.clock.now().toISOString() };
      this.tokens.set(token.tokenId, token);
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      return { encryptedPassData: b64(`pass:${token.tokenId}`), activationData: b64(`act:${token.tokenId}`), ephemeralPublicKey: b64(`epk:${token.tokenId}`) };
    })) as ProvisioningPayload;
  }

  async listTokens(cardId: string): Promise<readonly CardToken[]> {
    return [...this.tokens.values()].filter((t) => t.cardId === cardId).map((t) => ({ ...t }));
  }

  async setTokensStatus(cardId: string, status: 'active' | 'suspended', key: string): Promise<readonly CardToken[]> {
    return (await this.idem.run(key, async () => {
      for (const t of this.tokens.values()) if (t.cardId === cardId && t.status !== 'deleted') this.tokens.set(t.tokenId, { ...t, status, updatedAt: this.clock.now().toISOString() });
      return this.listTokens(cardId);
    })) as readonly CardToken[];
  }

  async parseTokenEvent(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; token: CardToken }> {
    if (headers['x-sim-signature'] !== 'sim') throw new WalletProvisioningError('BAD_SIGNATURE', 'Token webhook signature invalid');
    const b = JSON.parse(rawBody) as { eventId: string; tokenId: string; status: TokenStatus };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const t = this.tokens.get(b.tokenId);
    if (!t) throw new WalletProvisioningError('VALIDATION_FAILED', `Unknown token ${b.tokenId}`);
    const next = { ...t, status: b.status, updatedAt: this.clock.now().toISOString() };
    this.tokens.set(t.tokenId, next);
    const out = { eventId: b.eventId, token: { ...next } };
    this.events.set(b.eventId, out);
    return out;
  }

  /** Control-panel hook: a signed lifecycle webhook. */
  tokenEvent(tokenId: string, status: TokenStatus): { headers: Record<string, string>; rawBody: string } {
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: this.evIds.next(), tokenId, status }) };
  }
}

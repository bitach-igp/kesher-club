// A purse's transactions (T-0536, REQ-WAL-008): the member's own wallet account, read from the ledger's journals
// that post to it, newest first, 50 a page with a cursor. The ledger is the record, so there is no second table to
// drift from it. Each row is one journal: its kind in the contract's words, the direction from this purse's side
// (a credit-normal wallet: a positive posting is money out), the amount always positive, and when. A card
// authorisation is one row whose state follows the card's life: pending while held, settled once a clearing names the
// same authorisation, reversed once a release does; the clearing and the release are not rows of their own. A card
// spend carries its merchant category and country; the ledger keeps no merchant text, so there is nothing untrusted.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import { WALLET_FLAG } from './household.ts';

export const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TransactionKind = 'load' | 'p2p' | 'card' | 'fee' | 'fx' | 'payout' | 'addon' | 'allowance' | 'reversal';

/** Journal kinds as the member reads them. Releases and clearings are folded into the authorisation they settle. */
const KIND: Record<string, TransactionKind> = {
  load: 'load',
  auth_hold: 'card',
  p2p: 'p2p',
  p2p_hold: 'p2p',
  fx: 'fx',
  payout: 'payout',
  refund: 'payout',
  addon: 'addon',
  esim: 'addon',
  allowance: 'allowance',
  fee: 'fee',
};
/** Journals that settle or undo another row rather than being one. */
const FOLDED = ['card_clearing', 'auth_release', 'p2p_release', 'load_release', 'load_hold'];

export interface Transaction {
  id: string;
  kind: TransactionKind;
  direction: 'in' | 'out';
  amount: ReturnType<typeof toWire>;
  at: string;
  state: 'pending' | 'settled' | 'reversed';
  mcc?: string;
  country?: string;
}

interface Row {
  id: string;
  kind: string;
  reverses_id: string | null;
  effective_at: string | Date;
  metadata: Record<string, unknown>;
  amount_minor: string;
  currency: Currency;
  cleared: boolean;
  released: boolean;
}

/** The page's position: the last row's time and id, so rows minted in one millisecond never repeat or drop. */
const encodeCursor = (at: string, id: string): string => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const when = new Date(at ?? '');
  if (Number.isNaN(when.getTime()) || !UUID.test(id ?? '')) throw new DomainError('VALIDATION_FAILED', 'cursor is not one this API gave');
  return { at: when, id: id! };
}

export function toTransaction(r: Row): Transaction {
  const signed = BigInt(r.amount_minor);
  const kind: TransactionKind = r.reverses_id ? 'reversal' : (KIND[r.kind] ?? 'reversal');
  const state: Transaction['state'] = r.kind === 'auth_hold' ? (r.cleared ? 'settled' : r.released ? 'reversed' : 'pending') : 'settled';
  const mcc = typeof r.metadata['mcc'] === 'string' ? r.metadata['mcc'] : undefined;
  const country = typeof r.metadata['country'] === 'string' ? r.metadata['country'] : undefined;
  return {
    id: r.id,
    kind,
    direction: signed > 0n ? 'out' : 'in',
    amount: toWire(money(signed < 0n ? -signed : signed, r.currency)),
    at: new Date(r.effective_at).toISOString(),
    state,
    ...(kind === 'card' && mcc ? { mcc } : {}),
    ...(kind === 'card' && country ? { country } : {}),
  };
}

export class TransactionService {
  private readonly db: Database;
  private readonly flags: FeatureFlags;
  constructor(db: Database, flags: FeatureFlags) {
    this.db = db;
    this.flags = flags;
  }

  /** The member's own purse, by its account id; anyone else's, or a purse that is not a wallet, answers 404. */
  async page(accountId: string, ownerPartyId: string, cursor: string | undefined, limit = PAGE): Promise<{ items: Transaction[]; nextCursor?: string }> {
    if (!(await this.flags.isOn(WALLET_FLAG, { partyId: ownerPartyId }))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
    const owned = UUID.test(accountId) ? await this.db.query('select 1 from ledger.account where id = $1 and owner_party_id = $2 and type = $3', [accountId, ownerPartyId, 'wallet']) : { rowCount: 0 };
    if (!owned.rowCount) throw new DomainError('NOT_FOUND', 'Purse not found');
    return this.forAccount(accountId, cursor, limit);
  }

  /** One wallet account's rows, for the member or for their funder (T-0537), who has already been checked. */
  async forAccount(accountId: string, cursor: string | undefined, limit = PAGE): Promise<{ items: Transaction[]; nextCursor?: string }> {
    const after = decodeCursor(cursor);
    const r = await this.db.query<Row>(
      `select j.id, j.kind, j.reverses_id, j.effective_at, j.metadata, p.amount_minor::text as amount_minor, p.currency,
              exists (select 1 from ledger.journal c where c.kind = 'card_clearing' and c.metadata->>'authId' = j.metadata->>'authId') as cleared,
              exists (select 1 from ledger.journal x where x.kind = 'auth_release' and x.metadata->>'authId' = j.metadata->>'authId') as released
         from ledger.journal j join ledger.posting p on p.journal_id = j.id
        where p.account_id = $1 and j.kind <> all($2::text[])
          and ($3::timestamptz is null or (j.effective_at, j.id) < ($3::timestamptz, $4::uuid))
        order by j.effective_at desc, j.id desc
        limit $5`,
      [accountId, FOLDED, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const rows = r.rows.slice(0, limit);
    const last = rows.at(-1);
    return { items: rows.map(toTransaction), ...(r.rows.length > limit && last ? { nextCursor: encodeCursor(new Date(last.effective_at).toISOString(), last.id) } : {}) };
  }
}

export function transactionHandlers(transactions: TransactionService): Record<string, Handler> {
  return {
    listTransactions: route(async (req) => {
      const p = requirePrincipal(req);
      const asked = Number(req.query['limit'] ?? PAGE);
      const limit = Number.isInteger(asked) && asked >= 1 && asked <= 100 ? asked : PAGE;
      return ok(await transactions.page(req.params['id'] ?? '', p.partyId, req.query['cursor'], limit));
    }),
  };
}

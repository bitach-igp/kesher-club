// Test support (T-0786): a vendor credit port that obeys the documented contract (packages/ports/src/funding.ts): the FIRST final answer
// per key is stored and replayed for ever, whatever the input; a `pending` answer and an outage are not stored, so the same key is asked
// again. Never `spy.mockResolvedValueOnce`, which bypasses idempotency and invents a vendor that changes its mind about a key.
import { FundingError, type CreditResult, type FundingCreditPort, type FundingSimulator } from '@kesher/ports';

/** What the next fresh (or not yet final) call answers: `credited` asks the simulator, any other word but the two below is a refusal with that reason code. */
export type CreditScript = 'credited' | 'pending' | 'outage' | 'NOT_SUCCEEDED' | (string & {});

export interface HonestCreditVendor extends FundingCreditPort {
  /** Every key a call was made with, in order (replays included). */
  readonly calls: string[];
  /** What each call answered, as `{key}:{status}[:{reasonCode}]`, or `{key}:throw` when it failed; a replay is listed again. */
  readonly answers: string[];
  /** Answers consumed by the next calls that are not replays, in order; an empty script asks the simulator. */
  readonly script: CreditScript[];
  /** The key stored for the next fresh call's answer, then the call fails as an outage: the vendor answered, we never heard (T-0786 crash point). */
  loseNextAnswer: boolean;
}

export function honestCreditVendor(sim: FundingSimulator): HonestCreditVendor {
  const stored = new Map<string, CreditResult>();
  const calls: string[] = [];
  const answers: string[] = [];
  const said = (key: string, r: CreditResult) => answers.push(`${key}:${r.status}${r.reasonCode ? `:${r.reasonCode}` : ''}`);
  const script: CreditScript[] = [];
  const vendor: HonestCreditVendor = {
    calls,
    answers,
    script,
    loseNextAnswer: false,
    async creditWallet(input, key) {
      calls.push(key);
      const prior = stored.get(key);
      if (prior) {
        said(key, prior);
        return prior;
      }
      const next = script.shift();
      if (next === 'outage') {
        answers.push(`${key}:throw`);
        throw new FundingError('PROVIDER_UNAVAILABLE', 'Simulated funding outage');
      }
      if (next === 'pending') {
        said(key, { status: 'pending' });
        return { status: 'pending' };
      }
      const result: CreditResult = next === undefined || next === 'credited' ? await (sim as Required<FundingSimulator>).creditWallet(input, key) : { status: 'refused', reasonCode: next };
      if (result.status !== 'pending') stored.set(key, result);
      if (vendor.loseNextAnswer) {
        vendor.loseNextAnswer = false;
        answers.push(`${key}:throw`);
        throw new FundingError('PROVIDER_UNAVAILABLE', 'The answer was lost on the way back');
      }
      said(key, result);
      return result;
    },
  };
  return vendor;
}

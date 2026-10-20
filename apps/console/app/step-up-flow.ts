// The browser half of a step-up (T-0610, T-0612): options from the server action, the passkey assertion
// here, the token into the httpOnly cookie there. False when the person cancelled or the ceremony failed.
import { stepUpAssert } from '../src/passkey.ts';
import { beginStepUp, finishStepUp } from './step-up.ts';

export async function passkeyStepUp(): Promise<boolean> {
  const begun = await beginStepUp();
  if (!begun.ok) return false;
  let response: unknown;
  try {
    response = await stepUpAssert(begun.value);
  } catch {
    return false;
  }
  return (await finishStepUp(response)).ok;
}

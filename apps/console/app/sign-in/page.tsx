// Sign-in (T-0608): staff sign in with the passkey of the member account they already have. A local
// console also lists the seeded demo staff (T-0034), whose passkeys the persona picker holds.
import { getConfig } from '../../src/config.ts';
import { SignIn } from './SignIn.tsx';

export default function SignInPage() {
  const local = getConfig().CONSOLE_ENVIRONMENT === 'local';
  return (
    <>
      <h1>Sign in</h1>
      <div className="card">
        <p>Use the passkey of your Kesher Club account. Your phone can sign in for this computer.</p>
        <SignIn demo={local} />
      </div>
    </>
  );
}

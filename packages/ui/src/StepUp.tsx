// <StepUp/> (T-0115, REQ-AUTH-006): wraps a money action. When the API answers STEP_UP_REQUIRED the
// component runs the passkey ceremony, caches the 5-minute token, and retries the action once.
// Platform-agnostic: the WebAuthn / Expo-passkeys call and the HTTP calls are injected.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

export interface StepUpApi {
  /** POST /auth/step-up without a response → options. */
  startStepUp(): Promise<{ options: unknown }>;
  /** POST /auth/step-up with the assertion → token. */
  completeStepUp(response: unknown): Promise<{ stepUpToken: string; expiresAt: string }>;
}

export interface Authenticator {
  /** navigator.credentials.get on web, expo-passkeys on mobile. */
  assert(options: unknown): Promise<unknown>;
}

export type StepUpState = { kind: 'idle' } | { kind: 'prompting' } | { kind: 'verifying' } | { kind: 'running' } | { kind: 'error'; message: string; retry: () => void } | { kind: 'done' };

export interface StepUpContext {
  state: StepUpState;
  /** Runs `action` with a fresh step-up token, prompting the passkey when needed. */
  run<T>(action: (stepUpToken: string) => Promise<T>): Promise<T>;
  /** True when a cached token is still younger than 5 minutes (no prompt will show). */
  hasFreshToken(now?: Date): boolean;
}

export interface StepUpProps {
  api: StepUpApi;
  authenticator: Authenticator;
  now?: () => Date;
  /** Shown while prompting; defaults to the house copy. */
  prompt?: ReactNode;
  children: (ctx: StepUpContext) => ReactNode;
}

export const STEP_UP_TTL_MS = 5 * 60_000;

/** Error thrown by actions when the API answers STEP_UP_REQUIRED; the component also accepts any error with this code. */
export class StepUpRequired extends Error {
  readonly code = 'STEP_UP_REQUIRED';
  constructor() {
    super('STEP_UP_REQUIRED');
  }
}

const isStepUpRequired = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'STEP_UP_REQUIRED';

export function useStepUp({ api, authenticator, now = () => new Date() }: Omit<StepUpProps, 'children' | 'prompt'>): StepUpContext {
  const [state, setState] = useState<StepUpState>({ kind: 'idle' });
  const cached = useRef<{ token: string; expiresAt: number } | undefined>(undefined);

  const hasFreshToken = useCallback((at: Date = now()) => !!cached.current && cached.current.expiresAt >= at.getTime(), [now]);

  const obtain = useCallback(async (): Promise<string> => {
    setState({ kind: 'prompting' });
    const { options } = await api.startStepUp();
    const assertion = await authenticator.assert(options);
    setState({ kind: 'verifying' });
    const { stepUpToken, expiresAt } = await api.completeStepUp(assertion);
    // Trust the server's expiry but never beyond our own 5-minute ceiling.
    cached.current = { token: stepUpToken, expiresAt: Math.min(Date.parse(expiresAt), now().getTime() + STEP_UP_TTL_MS) };
    return stepUpToken;
  }, [api, authenticator, now]);

  const run = useCallback(
    async <T,>(action: (stepUpToken: string) => Promise<T>): Promise<T> => {
      const attempt = async (): Promise<T> => {
        try {
          const token = hasFreshToken() ? cached.current!.token : await obtain();
          setState({ kind: 'running' });
          const result = await action(token);
          setState({ kind: 'done' });
          return result;
        } catch (e) {
          if (isStepUpRequired(e)) {
            // The server disagreed about freshness (clock skew, revoked session): prompt once more, then give up.
            cached.current = undefined;
            const token = await obtain();
            setState({ kind: 'running' });
            const result = await action(token);
            setState({ kind: 'done' });
            return result;
          }
          const message = e instanceof Error ? e.message : 'Something went wrong';
          setState({ kind: 'error', message, retry: () => void attempt() });
          throw e;
        }
      };
      return attempt();
    },
    [hasFreshToken, obtain],
  );

  return useMemo(() => ({ state, run, hasFreshToken }), [state, run, hasFreshToken]);
}

export function StepUp({ children, prompt, ...rest }: StepUpProps) {
  const ctx = useStepUp(rest);
  return (
    <>
      {children(ctx)}
      {ctx.state.kind === 'prompting' && (
        <div role="dialog" aria-modal="true" aria-live="polite" data-testid="step-up-prompt">
          {prompt ?? 'Confirm with your passkey to continue.'}
        </div>
      )}
      {ctx.state.kind === 'error' && (
        <div role="alert" data-testid="step-up-error">
          {ctx.state.message} <button onClick={ctx.state.retry}>Try again</button>
        </div>
      )}
    </>
  );
}

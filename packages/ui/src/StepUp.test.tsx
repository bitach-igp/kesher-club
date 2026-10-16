// TST-AUTH-006 (client side): the StepUp wrapper prompts the passkey before a money action when no
// fresh token exists, reuses a token younger than 5 minutes, and re-prompts when the API insists.
// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StepUp, StepUpRequired, type StepUpContext } from './StepUp.tsx';

function harness(opts: { serverTtlMs?: number } = {}) {
  let t = Date.parse('2026-11-01T09:00:00Z');
  const now = () => new Date(t);
  const advance = (ms: number) => void (t += ms);
  const calls: string[] = [];
  const api = {
    startStepUp: async () => (calls.push('start'), { options: { challenge: 'c' } }),
    completeStepUp: async (r: unknown) => (calls.push(`complete:${JSON.stringify(r)}`), { stepUpToken: `su_${calls.length}`, expiresAt: new Date(t + (opts.serverTtlMs ?? 5 * 60_000)).toISOString() }),
  };
  const authenticator = { assert: async (o: unknown) => (calls.push('assert'), { signed: o }) };
  let ctx!: StepUpContext;
  render(
    <StepUp api={api} authenticator={authenticator} now={now}>
      {(c) => {
        ctx = c;
        return <span data-testid="state">{c.state.kind}</span>;
      }}
    </StepUp>,
  );
  return { calls, advance, get ctx() { return ctx; } };
}

describe('<StepUp/>', () => {
  it('prompts the passkey, then runs the action with the token', async () => {
    const h = harness();
    const sent: string[] = [];
    await act(() => h.ctx.run(async (token) => void sent.push(token)));
    expect(h.calls).toEqual(['start', 'assert', 'complete:{"signed":{"challenge":"c"}}']);
    expect(sent).toEqual(['su_3']);
    expect(screen.getByTestId('state').textContent).toBe('done');
  });

  it('reuses a token younger than 5 minutes and prompts again after it ages out', async () => {
    const h = harness();
    await act(() => h.ctx.run(async () => undefined));
    h.advance(4 * 60_000);
    await act(() => h.ctx.run(async () => undefined));
    expect(h.calls.filter((c) => c === 'assert').length).toBe(1);
    h.advance(60_001);
    await act(() => h.ctx.run(async () => undefined));
    expect(h.calls.filter((c) => c === 'assert').length).toBe(2);
  });

  it('never trusts a server expiry longer than 5 minutes', async () => {
    const h = harness({ serverTtlMs: 60 * 60_000 });
    await act(() => h.ctx.run(async () => undefined));
    expect(h.ctx.hasFreshToken(new Date(Date.parse('2026-11-01T09:05:00Z')))).toBe(true);
    expect(h.ctx.hasFreshToken(new Date(Date.parse('2026-11-01T09:05:01Z')))).toBe(false);
  });

  it('re-prompts once when the API still answers STEP_UP_REQUIRED, then surfaces other errors with a retry', async () => {
    const h = harness();
    let first = true;
    await act(() =>
      h.ctx.run(async () => {
        if (first) {
          first = false;
          throw new StepUpRequired();
        }
      }),
    );
    expect(h.calls.filter((c) => c === 'assert').length).toBe(2);
    let caught: unknown;
    await act(async () => {
      await h.ctx.run(async () => {
        throw new Error('Insufficient funds');
      }).catch((e: unknown) => (caught = e));
    });
    expect((caught as Error).message).toBe('Insufficient funds');
    expect(screen.getByRole('alert').textContent).toContain('Insufficient funds');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows an accessible prompt while the passkey sheet is up', async () => {
    const h = harness();
    let resolveAssert!: (v: unknown) => void;
    const slow = new Promise((r) => (resolveAssert = r));
    const slowApi = { ...{ startStepUp: async () => ({ options: {} }), completeStepUp: async () => ({ stepUpToken: 'x', expiresAt: new Date().toISOString() }) } };
    render(
      <StepUp api={slowApi} authenticator={{ assert: () => slow }} now={() => new Date()}>
        {(c) => <button onClick={() => void c.run(async () => undefined)}>Send</button>}
      </StepUp>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
    });
    expect(screen.getByRole('dialog').textContent).toContain('Confirm with your passkey');
    await act(async () => {
      resolveAssert({});
    });
    void h;
  });
});

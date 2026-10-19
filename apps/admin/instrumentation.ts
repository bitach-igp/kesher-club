// Next calls register() once when the server starts (T-0918). The config check needs Node, so it is
// imported only in the Node runtime; Next compiles this file for the Edge runtime too.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') (await import('./src/boot.ts')).bootCheck();
}

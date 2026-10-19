// One runner per job across worker tasks (T-0022). A run holds a session-level Postgres advisory lock
// keyed on the job's name and gives it back when the run ends; a task that finds it held skips the run.
// The lock lives on its own one-connection pool that never idles out (`idleTimeoutMs: 0`), so a run never
// waits on a pool slot its own queries need, and a pool reaping an idle client cannot drop a held lock.
// Locks are re-entrant within that one session, which is safe because the scheduler never overlaps a job
// with itself. If the connection dies mid-run, Postgres releases the lock and another task may start the
// job while this run finishes: the job bodies are idempotent on their workflow keys, so that costs work,
// never money. A `market` job's lock is scoped by market: the IL and US workers share one database, and
// the IL load sweep must not make the US one skip. A `club` job's lock is one for the whole club.
import { createHash } from 'node:crypto';
import type { SqlClient } from '@kesher/api/db';
import type { JobLock } from './scheduler.ts';

/** A signed 64-bit key from the scope and job name, so the lock space is ours and not Postgres's `hashtext`. */
export function lockKey(scope: string, name: string): bigint {
  return createHash('sha256').update(`kesher-job:${scope}:${name}`).digest().readBigInt64BE(0);
}

/** One runner per `market` job per market, and one per `club` job in the whole club. */
export function advisoryLock(session: SqlClient, market: string): JobLock {
  return {
    async withLock(job, fn) {
      const key = lockKey(job.scope === 'club' ? 'club' : market, job.name).toString();
      const got = await session.query<{ locked: boolean }>('select pg_try_advisory_lock($1::bigint) as locked', [key]);
      if (!got.rows[0]?.locked) return { ran: false };
      try {
        return { ran: true, value: await fn() };
      } finally {
        // A failed unlock means the session is gone, and the lock with it: the run's outcome stands.
        await session.query('select pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
      }
    },
  };
}

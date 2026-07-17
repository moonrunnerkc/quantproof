/**
 * Single-process guard per results database. Two sweeps against one
 * GPU corrupt each other's VRAM and latency measurements (design
 * principle: sequential isolation), so the second process must refuse
 * up front instead of silently interleaving. The lock lives in the
 * database itself and self-heals when the holding pid is dead.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS active_process (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  command TEXT NOT NULL
);
`;

/** A held lock; release it in a finally. */
export interface RunLock {
  /** Removes the lock row; safe to call twice. */
  release(): void;
}

/** Injectable liveness probe, for tests. */
export type PidProbe = (pid: number) => boolean;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user: alive.
    return err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'EPERM';
  }
}

/**
 * Acquires the per-database process lock or refuses politely.
 *
 * @param dbPath - Results database path (created if needed).
 * @param command - Human-readable holder description, e.g. "run".
 * @param options - pid/liveness overrides for tests.
 * @returns The held lock.
 * @throws Error naming the live holder (pid, command, start time) and
 *   what to do, when another quantproof process holds this database. A
 *   lock whose pid is dead is stale and is taken over silently.
 */
export function acquireRunLock(
  dbPath: string,
  command: string,
  options: { readonly pid?: number; readonly isAlive?: PidProbe } = {},
): RunLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(LOCK_SCHEMA);

  const takeover = db.transaction(() => {
    const holder = db.prepare('SELECT pid, started_at_ms, command FROM active_process WHERE id = 1').get() as
      | { pid: number; started_at_ms: number; command: string }
      | undefined;
    if (holder !== undefined && holder.pid !== pid && isAlive(holder.pid)) {
      const since = new Date(holder.started_at_ms).toISOString();
      throw new Error(
        `another quantproof process (pid ${String(holder.pid)}, "${holder.command}", running since ${since}) already holds ${dbPath}; ` +
          'wait for it to finish or stop it, then rerun. Two concurrent sweeps on one machine would corrupt both measurements.',
      );
    }
    db.prepare(
      'INSERT INTO active_process (id, pid, started_at_ms, command) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, started_at_ms = excluded.started_at_ms, command = excluded.command',
    ).run(pid, Date.now(), command);
  });

  try {
    takeover();
  } catch (err) {
    db.close();
    throw err;
  }

  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      released = true;
      try {
        db.prepare('DELETE FROM active_process WHERE id = 1 AND pid = ?').run(pid);
      } finally {
        db.close();
      }
    },
  };
}

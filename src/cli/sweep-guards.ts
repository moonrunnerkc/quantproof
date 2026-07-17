/**
 * Shared guards around a sweep: the single-process lock, and a SIGINT
 * handler that tells the user their finished work is safe and how to
 * continue. The journal is transactional per unit, so an interrupt
 * loses at most the generation in flight.
 */

import { acquireRunLock } from '../results/process-lock.js';

/** Hooks injectable by tests; production uses the defaults. */
export interface GuardHooks {
  readonly exit?: (code: number) => void;
  readonly notify?: (line: string) => void;
}

/**
 * Runs a sweep-like operation under the process lock with a SIGINT
 * notice installed.
 *
 * @param dbPath - Results database path the lock protects.
 * @param command - Holder description for the lock ("run", "resume").
 * @param fn - The guarded operation.
 * @param hooks - Test overrides for exit and stderr.
 * @returns Whatever `fn` returns.
 * @throws The lock refusal when another process holds the database, or
 *   whatever `fn` throws; the lock is always released.
 */
export async function withSweepGuards<T>(
  dbPath: string,
  command: string,
  fn: () => Promise<T>,
  hooks: GuardHooks = {},
): Promise<T> {
  const exit = hooks.exit ?? ((code: number): void => {
    process.exit(code);
  });
  const notify = hooks.notify ?? ((line: string): void => {
    console.error(line);
  });
  const lock = acquireRunLock(dbPath, command);
  const onInterrupt = (): void => {
    notify(
      `\ninterrupted; every completed unit is already journaled, continue with: quantproof resume --db ${dbPath}`,
    );
    lock.release();
    exit(130);
  };
  process.once('SIGINT', onInterrupt);
  try {
    return await fn();
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    lock.release();
  }
}

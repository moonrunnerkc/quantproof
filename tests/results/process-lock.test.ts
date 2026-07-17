import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireRunLock } from '../../src/results/process-lock.js';
import { withSweepGuards } from '../../src/cli/sweep-guards.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-lock-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireRunLock', () => {
  it('refuses while another live process holds the database, naming the holder', () => {
    const db = join(dir, 'held.db');
    const first = acquireRunLock(db, 'run --pack examples/x', { pid: 11111, isAlive: () => true });
    try {
      expect(() => acquireRunLock(db, 'resume', { pid: 22222, isAlive: () => true })).toThrow(
        /another quantproof process \(pid 11111, "run --pack examples\/x".*already holds.*wait for it to finish or stop it/s,
      );
    } finally {
      first.release();
    }
  });

  it('takes over a stale lock whose pid is dead', () => {
    const db = join(dir, 'stale.db');
    // Simulate a crash: the lock row stays behind and its pid is gone.
    acquireRunLock(db, 'run', { pid: 33333, isAlive: () => true });
    const second = acquireRunLock(db, 'resume', { pid: 44444, isAlive: () => false });
    second.release();
  });

  it('releases cleanly so the next process can acquire', () => {
    const db = join(dir, 'release.db');
    acquireRunLock(db, 'run', { pid: 1, isAlive: () => true }).release();
    const next = acquireRunLock(db, 'run', { pid: 2, isAlive: () => true });
    next.release();
  });

  it('release is idempotent', () => {
    const lock = acquireRunLock(join(dir, 'idem.db'), 'run', { pid: 5, isAlive: () => true });
    lock.release();
    expect(() => {
      lock.release();
    }).not.toThrow();
  });
});

describe('withSweepGuards', () => {
  it('holds the lock for the duration and releases it after', async () => {
    const db = join(dir, 'guard.db');
    await withSweepGuards(db, 'run', async () => {
      expect(() => acquireRunLock(db, 'run', { pid: process.pid + 1, isAlive: () => true })).toThrow(
        /already holds/,
      );
      return Promise.resolve('done');
    });
    acquireRunLock(db, 'run', { pid: process.pid + 1, isAlive: () => true }).release();
  });

  it('releases the lock when the guarded operation throws', async () => {
    const db = join(dir, 'guard-throw.db');
    await expect(
      withSweepGuards(db, 'run', () => Promise.reject(new Error('sweep exploded'))),
    ).rejects.toThrow('sweep exploded');
    acquireRunLock(db, 'run', { pid: process.pid + 1, isAlive: () => true }).release();
  });

  it('on SIGINT prints the resume command, releases, and exits 130', async () => {
    const db = join(dir, 'guard-sigint.db');
    const lines: string[] = [];
    const exits: number[] = [];
    await withSweepGuards(
      db,
      'run',
      () =>
        new Promise<string>((resolveRun) => {
          process.emit('SIGINT');
          setImmediate(() => {
            resolveRun('finished anyway');
          });
        }),
      {
        exit: (code) => {
          exits.push(code);
        },
        notify: (line) => {
          lines.push(line);
        },
      },
    );
    expect(exits).toEqual([130]);
    expect(lines[0]).toContain('every completed unit is already journaled');
    expect(lines[0]).toContain(`quantproof resume --db ${db}`);
    // The handler released the lock, so a new process can take it.
    acquireRunLock(db, 'run', { pid: process.pid + 1, isAlive: () => true }).release();
  });
});

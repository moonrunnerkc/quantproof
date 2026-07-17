/**
 * Journal-based resume: find the newest incomplete run, verify that
 * nothing that shaped its plan has changed on disk, and rebuild a
 * prepared sweep holding only the units that still need to run. Units
 * that completed, failed, or were skipped as OOM stay exactly as
 * journaled; resume never re-attempts them.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PreparedSweep } from './run-executor.js';
import type { RunRecord } from '../results/record-types.js';
import type { RunStore } from '../results/run-store.js';

/**
 * Fingerprints a task pack directory: sha256 over every file's
 * relative path and content, walked in sorted order.
 *
 * @param packDir - The pack directory.
 * @returns Hex digest. Throws when the directory is unreadable.
 */
export function packFingerprint(packDir: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        hash.update(relative(packDir, path));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  walk(packDir);
  return hash.digest('hex');
}

/**
 * Fingerprints a run config file.
 *
 * @param configPath - The config file path, or null when the run used
 *   defaults.
 * @returns Hex digest, or null for a null path. Throws when the file
 *   is gone; that is drift and the caller reports it.
 */
export function configFingerprint(configPath: string | null): string | null {
  if (configPath === null) {
    return null;
  }
  return createHash('sha256').update(readFileSync(configPath)).digest('hex');
}

/**
 * Finds the newest run that still has pending work.
 *
 * @param store - Open results store.
 * @returns The run, or null when every journaled run is complete.
 */
export function findResumableRun(store: RunStore): RunRecord | null {
  for (const run of store.listRuns()) {
    const hasPending = store.listUnitResults(run.id).some((u) => u.status === 'pending');
    if (hasPending) {
      return run;
    }
  }
  return null;
}

/**
 * Verifies that the pack and config a run was planned from are
 * byte-identical to what is on disk now.
 *
 * @param run - The run to resume.
 * @throws Error explaining exactly what drifted and why resume refuses
 *   to continue (results would silently mix two configurations).
 */
export function verifyNoDrift(run: RunRecord): void {
  const currentPack = packFingerprint(run.packDir);
  if (currentPack !== run.plan.packFingerprint) {
    throw new Error(
      `task pack ${run.packDir} changed on disk since run ${run.id} was planned, so resuming would mix results from two different packs; rerun quantproof run to start a fresh run, or restore the pack files`,
    );
  }
  if (run.plan.configPath !== null) {
    let current: string | null;
    try {
      current = configFingerprint(run.plan.configPath);
    } catch (err) {
      throw new Error(
        `run config ${run.plan.configPath} is no longer readable, so run ${run.id} cannot be resumed exactly; restore the file or start a fresh run`,
        { cause: err },
      );
    }
    if (current !== run.plan.configFingerprint) {
      throw new Error(
        `run config ${run.plan.configPath} changed on disk since run ${run.id} was planned; resume refuses to mix configurations, so restore the file or start a fresh run`,
      );
    }
  }
}

/**
 * Rebuilds a prepared sweep from the journal: candidates in their
 * original order, each restricted to its still-pending units. OOM
 * candidates have no pending units (they were skipped at
 * classification time) and drop out naturally; the filter below also
 * guards against re-attempting one whose skip write never landed.
 *
 * @param store - Open results store.
 * @param run - The verified run.
 * @returns A prepared sweep containing only unfinished work.
 */
export function buildResume(store: RunStore, run: RunRecord): PreparedSweep {
  const unitsByCandidate = new Map<string, ReturnType<RunStore['listUnitResults']>>();
  for (const result of store.listUnitResults(run.id)) {
    const list = unitsByCandidate.get(result.unit.candidateId) ?? [];
    list.push(result);
    unitsByCandidate.set(result.unit.candidateId, list);
  }
  const entries = store
    .listCandidates(run.id)
    .filter((candidate) => candidate.status !== 'oom')
    .map((candidate) => ({
      candidate: candidate.record,
      units: (unitsByCandidate.get(candidate.record.id) ?? [])
        .filter((result) => result.status === 'pending')
        .map((result) => result.unit),
    }))
    .filter((entry) => entry.units.length > 0);
  return { run, entries };
}

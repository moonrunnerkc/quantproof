/**
 * Re-scoring stored runs from raw outputs. Scorers version with the
 * code, not with the run, so a report rendered today re-scores every
 * retained output with today's scorers; when anything changes the
 * report says so instead of silently mixing eras. A drifted or missing
 * pack skips re-scoring, also loudly.
 */

import { packFingerprint } from '../orchestrator/recovery.js';
import type { RunRecord, UnitResult } from '../results/record-types.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { scoreWithGates } from '../scoring/gate-composition.js';
import { bindPackScorers } from '../scoring/plan-check.js';
import { listScorers } from '../scoring/scorer-registry.js';
import { loadTaskPack } from '../tasks/task-loader.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';

/** Outcome of a re-score pass over one run's units. */
export interface RescoreResult {
  /** Units with fresh scores where re-scoring ran and found changes. */
  readonly units: readonly UnitResult[];
  /** Caveats for the report (drift, skipped re-scoring, changed values). */
  readonly notes: readonly string[];
  /** The loaded pack when it still matches the run; null otherwise. */
  readonly pack: LoadedTaskPack | null;
}

/**
 * Re-scores a run's completed units from their retained raw outputs.
 *
 * When the pack at run.packDir still matches the fingerprint recorded
 * at plan time, every completed unit is re-scored with the current
 * scorers; differing values replace the stored ones and a note says
 * how many changed. When the pack is missing or drifted, stored scores
 * pass through untouched with a note explaining why.
 *
 * @param run - The stored run.
 * @param units - The run's unit results as read from the store.
 * @returns Units (re-scored or as stored), notes, and the pack.
 */
export function rescoreUnits(run: RunRecord, units: readonly UnitResult[]): RescoreResult {
  registerBuiltinScorers();
  let pack: LoadedTaskPack;
  try {
    pack = loadTaskPack(run.packDir, listScorers());
  } catch (err) {
    return {
      units,
      notes: [
        `stored scores shown as recorded: the task pack at ${run.packDir} could not be loaded (${err instanceof Error ? err.message.split('\n')[0] ?? 'unknown error' : String(err)}), so outputs were not re-scored`,
      ],
      pack: null,
    };
  }
  if (packFingerprint(run.packDir) !== run.plan.packFingerprint) {
    return {
      units,
      notes: [
        `stored scores shown as recorded: the task pack at ${run.packDir} changed since this run, so re-scoring its outputs against the current examples would compare against different expected values`,
      ],
      pack: null,
    };
  }

  const { primary, gates } = bindPackScorers(pack);
  const expectedById = new Map(pack.examples.map((e) => [e.id, e.expected]));
  let changed = 0;
  let checked = 0;
  const rescored = units.map((unit) => {
    if (unit.status !== 'completed' || unit.generation === null || unit.score === null) {
      return unit;
    }
    if (!expectedById.has(unit.unit.exampleId)) {
      return unit;
    }
    checked += 1;
    const fresh = scoreWithGates(unit.generation.output, expectedById.get(unit.unit.exampleId), primary, gates);
    const freshDetails = JSON.parse(JSON.stringify(fresh.details)) as Record<string, unknown>;
    const same =
      fresh.score === unit.score.score &&
      fresh.pass === unit.score.pass &&
      JSON.stringify(freshDetails) === JSON.stringify(unit.score.details);
    if (same) {
      return unit;
    }
    changed += 1;
    return {
      ...unit,
      score: { ...unit.score, score: fresh.score, pass: fresh.pass, details: freshDetails },
    };
  });
  return {
    units: rescored,
    notes:
      changed === 0
        ? []
        : [
            `re-scored from raw outputs with the current scorers: ${String(changed)} of ${String(checked)} scores changed from the stored values (scorer behavior has been updated since this run)`,
          ],
    pack,
  };
}

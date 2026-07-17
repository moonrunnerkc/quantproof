/**
 * Plan-time scoring validation: every scorer throw that would otherwise
 * surface mid-sweep (bad params, expected values whose type does not
 * match the scorer) is provoked here, before any inference, by scoring
 * an empty output against every example. Scorers throw only on
 * authoring errors, never on model output, so a throw here is always a
 * pack problem the user can fix now.
 */

import type { BoundScorer } from './gate-composition.js';
import { scoreWithGates } from './gate-composition.js';
import { getScorer } from './scorer-registry.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';

/** A loaded pack's scorers bound to their declared params. */
export interface PackScorers {
  readonly primary: BoundScorer;
  readonly gates: readonly BoundScorer[];
}

/**
 * Binds a loaded pack's primary and gate scorers from the registry.
 *
 * @param pack - The loaded task pack.
 * @returns Bound scorers ready for scoreWithGates.
 * @throws Error from the registry when a scorer name is unknown (the
 *   loader validates names, so this indicates a registry mismatch).
 */
export function bindPackScorers(pack: LoadedTaskPack): PackScorers {
  return {
    primary: {
      name: pack.manifest.scorer,
      scorer: getScorer(pack.manifest.scorer),
      params: pack.scorerParams,
    },
    gates: pack.gates.map((gate) => ({
      name: gate.scorer,
      scorer: getScorer(gate.scorer),
      params: gate.scorerParams,
    })),
  };
}

/**
 * Dry-scores every example so authoring errors die at plan time.
 *
 * @param pack - The loaded task pack.
 * @returns Every problem found across all examples in one pass, each
 *   naming the example file; identical messages (a bad param hits every
 *   example the same way) are collapsed to one. Empty means clean.
 */
export function checkExpectedValues(pack: LoadedTaskPack): string[] {
  const { primary, gates } = bindPackScorers(pack);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const example of pack.examples) {
    try {
      scoreWithGates('', example.expected, primary, gates);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (seen.has(message)) {
        continue;
      }
      seen.add(message);
      problems.push(`${example.sourcePath}: ${message}`);
    }
  }
  return problems;
}

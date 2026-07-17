/**
 * Aggregation over unit results: quality with its spread across
 * repetitions, latency medians, and completion counts. Variance is a
 * first-class output here, never averaged away.
 */

import type { UnitResult } from '../results/record-types.js';

/** Mean quality of one full repetition pass over the examples. */
export interface RepetitionQuality {
  readonly repetition: number;
  readonly meanScore: number;
}

/** Everything the report table needs for one candidate. */
export interface RunSummary {
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
  /** Mean score over all completed units. Null with zero completions. */
  readonly meanScore: number | null;
  /** Fraction of completed units that passed. Null with zero completions. */
  readonly passRate: number | null;
  /** Per-repetition means, ascending by repetition. */
  readonly repetitions: readonly RepetitionQuality[];
  /** Spread of the per-repetition means; null with zero completions. */
  readonly scoreSpread: { readonly min: number; readonly max: number } | null;
  readonly ttftMedianMs: number | null;
  readonly tokensPerSecondMedian: number | null;
  readonly wallMsTotal: number;
  /**
   * True when every example's output is byte-identical across all of
   * its completed repetitions; false means the backend did not honor
   * the fixed seed. Null when no example completed more than once.
   */
  readonly outputsDeterministic: boolean | null;
}

/**
 * Median of a numeric list.
 *
 * @param values - Sample values in any order.
 * @returns The median, or null for an empty list.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Aggregates a run's unit results into the report summary.
 *
 * @param results - All unit results of a run, any status.
 * @returns The summary; degenerate inputs (nothing completed) produce
 *   nulls, not fabricated numbers.
 */
export function summarizeRun(results: readonly UnitResult[]): RunSummary {
  const done = results.filter((r) => r.status === 'completed' && r.score !== null);
  const scores = done.map((r) => r.score?.score ?? 0);

  const byRepetition = new Map<number, number[]>();
  const byExample = new Map<string, string[]>();
  for (const result of done) {
    const rep = byRepetition.get(result.unit.repetition) ?? [];
    rep.push(result.score?.score ?? 0);
    byRepetition.set(result.unit.repetition, rep);
    const outputs = byExample.get(result.unit.exampleId) ?? [];
    outputs.push(result.generation?.output ?? '');
    byExample.set(result.unit.exampleId, outputs);
  }
  const repetitions = [...byRepetition.entries()]
    .map(([repetition, values]) => ({ repetition, meanScore: mean(values) }))
    .sort((a, b) => a.repetition - b.repetition);
  const repMeans = repetitions.map((r) => r.meanScore);

  const multiRepExamples = [...byExample.values()].filter((outputs) => outputs.length > 1);
  const outputsDeterministic =
    multiRepExamples.length === 0
      ? null
      : multiRepExamples.every((outputs) => outputs.every((o) => o === outputs[0]));

  return {
    completed: done.length,
    failed: results.filter((r) => r.status === 'failed').length,
    pending: results.filter((r) => r.status === 'pending').length,
    meanScore: scores.length === 0 ? null : mean(scores),
    passRate: done.length === 0 ? null : done.filter((r) => r.score?.pass === true).length / done.length,
    repetitions,
    scoreSpread:
      repMeans.length === 0 ? null : { min: Math.min(...repMeans), max: Math.max(...repMeans) },
    ttftMedianMs: median(
      done.map((r) => r.generation?.ttftMs).filter((v): v is number => typeof v === 'number'),
    ),
    tokensPerSecondMedian: median(
      done
        .map((r) => r.generation?.tokensPerSecond)
        .filter((v): v is number => typeof v === 'number'),
    ),
    wallMsTotal: done.reduce((sum, r) => sum + (r.generation?.wallMs ?? 0), 0),
    outputsDeterministic,
  };
}

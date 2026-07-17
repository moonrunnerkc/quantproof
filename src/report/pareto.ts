/**
 * Pareto frontier over the three measured axes: quality (higher wins),
 * peak VRAM (lower wins), and median tokens per second (higher wins).
 * Only gate-passing candidates compete; everything else is reported as
 * excluded with the reason so the frontier never hides a result.
 */

import { isGatePassing } from './aggregate.js';
import type { CandidateAggregate } from './aggregate.js';

/** One frontier competitor with its axis values extracted. */
export interface ParetoPoint {
  readonly aggregate: CandidateAggregate;
  readonly quality: number;
  /** Measured peak MiB; null when VRAM was not measured. */
  readonly vramMib: number | null;
  readonly tokensPerSecond: number | null;
}

/** The frontier plus everything that could not compete. */
export interface ParetoResult {
  /** Non-dominated points in input order; ties both stay. */
  readonly frontier: readonly ParetoPoint[];
  /** Gate-passing points dominated by a frontier member. */
  readonly dominated: readonly ParetoPoint[];
  /** Candidates that never competed, each with the reason. */
  readonly excluded: readonly {
    readonly aggregate: CandidateAggregate;
    readonly reason: string;
  }[];
}

/**
 * Why an aggregate cannot compete on the frontier or be recommended:
 * it OOMed, failed, never scored, or failed a gate scorer. Null when
 * the candidate is a legitimate competitor.
 *
 * @param aggregate - The candidate's aggregate.
 * @returns The reason, or null for an eligible candidate.
 */
export function ineligibilityReason(aggregate: CandidateAggregate): string | null {
  if (aggregate.status === 'oom') {
    return `did not run: ${aggregate.statusReason ?? 'out of memory'}`;
  }
  if (aggregate.status === 'running') {
    return 'interrupted before finishing; quantproof resume will complete its pending units';
  }
  if (aggregate.status !== 'completed') {
    return `did not complete: ${aggregate.statusReason ?? 'no reason recorded'}`;
  }
  if (aggregate.summary.meanScore === null) {
    return 'no completed generations to score';
  }
  if (aggregate.gatesPassed !== true) {
    const gates = Object.entries(aggregate.gateFailureCounts)
      .map(([gate, count]) => `${gate} (${String(count)} unit${count === 1 ? '' : 's'})`)
      .join(', ');
    return `failed gate scorers: ${gates === '' ? 'gate outcomes unavailable' : gates}`;
  }
  return null;
}

/**
 * Compares two points on one axis. Missing measurements compare as
 * equal: an unmeasured axis can neither dominate nor be dominated,
 * which keeps GPU-less runs honest instead of inventing an ordering.
 */
function axisCompare(a: number | null, b: number | null, higherWins: boolean): -1 | 0 | 1 {
  if (a === null || b === null || a === b) {
    return 0;
  }
  const aWins = higherWins ? a > b : a < b;
  return aWins ? 1 : -1;
}

/** True when `a` dominates `b`: no worse on every axis, better on one. */
export function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  const comparisons = [
    axisCompare(a.quality, b.quality, true),
    axisCompare(a.vramMib, b.vramMib, false),
    axisCompare(a.tokensPerSecond, b.tokensPerSecond, true),
  ];
  return comparisons.every((c) => c >= 0) && comparisons.some((c) => c === 1);
}

/**
 * Computes the quality/VRAM/throughput Pareto frontier for a run.
 *
 * @param aggregates - Every candidate aggregate of the run.
 * @returns Frontier, dominated points, and exclusions with reasons.
 *   Candidates with identical axis values all stay on the frontier;
 *   an empty frontier means no candidate passed the gates.
 */
export function paretoFrontier(aggregates: readonly CandidateAggregate[]): ParetoResult {
  const excluded: { aggregate: CandidateAggregate; reason: string }[] = [];
  const points: ParetoPoint[] = [];
  for (const aggregate of aggregates) {
    const reason = ineligibilityReason(aggregate);
    if (reason !== null || !isGatePassing(aggregate)) {
      excluded.push({ aggregate, reason: reason ?? 'not eligible' });
      continue;
    }
    points.push({
      aggregate,
      quality: aggregate.summary.meanScore ?? 0,
      vramMib: aggregate.measuredPeakMib,
      tokensPerSecond: aggregate.summary.tokensPerSecondMedian,
    });
  }
  const frontier = points.filter((point) => !points.some((other) => dominates(other, point)));
  const frontierSet = new Set(frontier);
  return {
    frontier,
    dominated: points.filter((point) => !frontierSet.has(point)),
    excluded,
  };
}

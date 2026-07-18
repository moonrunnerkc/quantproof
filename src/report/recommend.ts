/**
 * The recommendation: among gate-passing candidates, the smallest peak
 * VRAM within a quality tolerance (default 2%, relative) of the best
 * measured quality. Every non-recommended candidate gets a why-not, and
 * a run where nothing passes the gates says so plainly instead of
 * recommending the least bad option.
 */

import { isGatePassing } from './aggregate.js';
import type { CandidateAggregate } from './aggregate.js';
import { ineligibilityReason } from './pareto.js';

const MIB = 1024 * 1024;

/** Recommendation tuning. */
export interface RecommendOptions {
  /** Relative quality tolerance in [0, 1); default 0.02 (2%). */
  readonly qualityTolerance?: number;
}

/** A candidate that was not recommended, with the reason why. */
export interface RunnerUp {
  readonly aggregate: CandidateAggregate;
  readonly reason: string;
}

/** The recommendation outcome for a run. */
export type Recommendation =
  | {
      readonly kind: 'recommended';
      readonly pick: CandidateAggregate;
      /** One sentence citing the numbers behind the pick. */
      readonly reason: string;
      readonly runnersUp: readonly RunnerUp[];
    }
  | {
      readonly kind: 'none';
      readonly reason: string;
      /** Closest candidates, best quality first, each with its blocker. */
      readonly nearestMisses: readonly RunnerUp[];
    };

const quality = (aggregate: CandidateAggregate): number => aggregate.summary.meanScore ?? 0;
const rate = (aggregate: CandidateAggregate): number => aggregate.summary.tokensPerSecondMedian ?? 0;

/**
 * How picks are ordered: measured VRAM, weights on disk as the proxy
 * when VRAM was unmeasured, or none at all for API backends (no local
 * footprint exists, so ranking uses quality and latency only).
 */
interface Footprint {
  readonly kind: 'vram' | 'weights' | 'none';
  readonly mib: (aggregate: CandidateAggregate) => number;
}

function footprintFor(withinTolerance: readonly CandidateAggregate[]): Footprint {
  if (withinTolerance.every((a) => a.measuredPeakMib !== null)) {
    return { kind: 'vram', mib: (a) => a.measuredPeakMib ?? Number.POSITIVE_INFINITY };
  }
  if (withinTolerance.every((a) => a.candidate.sizeBytes === 0)) {
    return { kind: 'none', mib: () => 0 };
  }
  return { kind: 'weights', mib: (a) => a.candidate.sizeBytes / MIB };
}

function pickSmallest(withinTolerance: readonly CandidateAggregate[], footprint: Footprint): CandidateAggregate {
  return [...withinTolerance].sort((a, b) => {
    if (footprint.kind === 'none') {
      const byQuality = quality(b) - quality(a);
      if (byQuality !== 0) {
        return byQuality;
      }
      const byRate = rate(b) - rate(a);
      return byRate !== 0 ? byRate : a.candidate.modelName.localeCompare(b.candidate.modelName);
    }
    const byFootprint = footprint.mib(a) - footprint.mib(b);
    if (byFootprint !== 0) {
      return byFootprint;
    }
    const byQuality = quality(b) - quality(a);
    if (byQuality !== 0) {
      return byQuality;
    }
    const byRate = rate(b) - rate(a);
    return byRate !== 0 ? byRate : a.candidate.modelName.localeCompare(b.candidate.modelName);
  })[0] as CandidateAggregate;
}

function pickReason(
  pick: CandidateAggregate,
  best: CandidateAggregate,
  tolerance: number,
  footprint: Footprint,
): string {
  if (footprint.kind === 'none') {
    return (
      `${pick.candidate.modelName} has the best measured quality (${quality(pick).toFixed(3)}) at ${rate(pick).toFixed(1)} tok/s ` +
      'among gate-passing candidates; this is an API backend run, so the ranking uses quality and latency only (no local footprint applies).'
    );
  }
  const size =
    footprint.kind === 'vram'
      ? `${footprint.mib(pick).toFixed(0)} MiB peak memory`
      : `${footprint.mib(pick).toFixed(0)} MiB weights on disk (peak memory was not measured on this run)`;
  if (pick === best) {
    return `${pick.candidate.modelName} has the best measured quality (${quality(pick).toFixed(3)}) and the smallest footprint (${size}) among the candidates within the quality tolerance.`;
  }
  return (
    `${pick.candidate.modelName} holds quality ${quality(pick).toFixed(3)}, within ${(tolerance * 100).toFixed(0)}% of the best ` +
    `(${quality(best).toFixed(3)} from ${best.candidate.modelName}), at ${size} versus ${footprint.mib(best).toFixed(0)} MiB.`
  );
}

function runnerUpReason(
  aggregate: CandidateAggregate,
  pick: CandidateAggregate,
  best: CandidateAggregate,
  threshold: number,
  footprint: Footprint,
): string {
  const blocked = ineligibilityReason(aggregate);
  if (blocked !== null) {
    return blocked;
  }
  if (quality(aggregate) < threshold) {
    const dropPercent = ((quality(best) - quality(aggregate)) / quality(best)) * 100;
    return `quality ${quality(aggregate).toFixed(3)} is ${dropPercent.toFixed(1)}% below the best ${quality(best).toFixed(3)}, outside the tolerance`;
  }
  if (footprint.kind === 'none') {
    return `same quality band but ${rate(aggregate).toFixed(1)} tok/s median versus ${rate(pick).toFixed(1)} for ${pick.candidate.modelName}`;
  }
  const extra = footprint.mib(aggregate) - footprint.mib(pick);
  if (extra === 0) {
    return `identical footprint to ${pick.candidate.modelName}; lost the tie-break on quality, then throughput`;
  }
  const unit = footprint.kind === 'vram' ? 'MiB more peak memory' : 'MiB more weights';
  return `same quality band but ${extra.toFixed(0)} ${unit} than ${pick.candidate.modelName}`;
}

/**
 * Recommends one candidate for a run, or says plainly that none
 * qualifies.
 *
 * @param aggregates - Every candidate aggregate of the run.
 * @param options - Tolerance override; default 2% relative to the best
 *   measured quality.
 * @returns The pick with a one-sentence numeric reason and runners-up,
 *   or the no-qualifier outcome with nearest misses.
 * @throws Error when qualityTolerance is outside [0, 1); pass a
 *   fraction like 0.02, not a percent.
 */
export function recommend(
  aggregates: readonly CandidateAggregate[],
  options: RecommendOptions = {},
): Recommendation {
  const tolerance = options.qualityTolerance ?? 0.02;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) {
    throw new Error(
      `qualityTolerance must be a fraction in [0, 1), got ${String(tolerance)}; pass 0.02 for a 2% tolerance`,
    );
  }

  const eligible = aggregates.filter(isGatePassing);
  if (eligible.length === 0) {
    const nearestMisses = [...aggregates]
      .sort((a, b) => quality(b) - quality(a))
      .map((aggregate) => ({
        aggregate,
        reason: ineligibilityReason(aggregate) ?? 'not eligible',
      }));
    return {
      kind: 'none',
      reason:
        aggregates.length === 0
          ? 'no candidates were evaluated'
          : 'no candidate passed all gate scorers, so nothing is recommendable on this task',
      nearestMisses,
    };
  }

  const best = [...eligible].sort((a, b) => quality(b) - quality(a))[0] as CandidateAggregate;
  const threshold = quality(best) * (1 - tolerance);
  const withinTolerance = eligible.filter((a) => quality(a) >= threshold);
  const footprint = footprintFor(withinTolerance);
  const pick = pickSmallest(withinTolerance, footprint);

  const runnersUp = aggregates
    .filter((a) => a !== pick)
    .map((aggregate) => ({
      aggregate,
      reason: runnerUpReason(aggregate, pick, best, threshold, footprint),
    }))
    .sort((a, b) => quality(b.aggregate) - quality(a.aggregate));

  return {
    kind: 'recommended',
    pick,
    reason: pickReason(pick, best, tolerance, footprint),
    runnersUp,
  };
}

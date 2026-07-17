/**
 * Run planning: assess candidates (architecture + fit), filter the
 * ones predicted not to fit (unless forced), order largest first so
 * OOM surprises surface early, and render the plan with a rough time
 * estimate before anything runs.
 */

import type { ModelDescriptor } from '../backends/backend-adapter.js';
import { predictFit } from '../catalog/fit-predictor.js';
import type { FitPrediction } from '../catalog/fit-predictor.js';
import { resolveArchitecture } from '../catalog/gguf-metadata.js';
import type { ModelArchitecture, ModelInfoSource } from '../catalog/gguf-metadata.js';

/** A candidate with everything the planner knows about it. */
export interface CandidateAssessment {
  readonly descriptor: ModelDescriptor;
  readonly architecture: ModelArchitecture | null;
  readonly fit: FitPrediction;
}

/** The executable plan plus what was cut and why. */
export interface RunPlan {
  /** Candidates to run, largest weights first. */
  readonly included: readonly CandidateAssessment[];
  /** Candidates excluded from execution, each with its reason. */
  readonly skipped: readonly { readonly assessment: CandidateAssessment; readonly reason: string }[];
  readonly unitsPerCandidate: number;
  /** Initial per-candidate estimate; refined once real timing exists. */
  readonly estimatedSecondsPerCandidate: number;
}

/** Pre-measurement throughput guess for the initial time estimate. */
const ASSUMED_TOKENS_PER_SECOND = 20;
/** Flat allowance per unit for prompt eval and round trips. */
const PER_UNIT_OVERHEAD_SECONDS = 2;
/** Flat allowance per candidate for load, warmup, unload, cooldown. */
const PER_CANDIDATE_OVERHEAD_SECONDS = 30;

/**
 * Estimates seconds for one candidate's units.
 *
 * @param units - Unit count for the candidate.
 * @param maxTokens - The manifest's generation cap per unit.
 * @param tokensPerSecond - Measured rate when available; the fixed
 *   heuristic guess otherwise.
 * @returns Whole seconds.
 */
export function estimateSeconds(
  units: number,
  maxTokens: number,
  tokensPerSecond: number = ASSUMED_TOKENS_PER_SECOND,
): number {
  return Math.round(units * (maxTokens / tokensPerSecond + PER_UNIT_OVERHEAD_SECONDS) + PER_CANDIDATE_OVERHEAD_SECONDS);
}

/**
 * Resolves architecture and fit for every candidate.
 *
 * @param source - Show-metadata source (the Ollama adapter).
 * @param descriptors - Resolved candidates.
 * @param context - The pack's declared context length.
 * @param freeVramMib - Free VRAM sampled at plan time; null without
 *   GPU telemetry.
 * @returns One assessment per descriptor, in input order.
 */
export async function assessCandidates(
  source: ModelInfoSource,
  descriptors: readonly ModelDescriptor[],
  context: number,
  freeVramMib: number | null,
): Promise<CandidateAssessment[]> {
  const assessments: CandidateAssessment[] = [];
  for (const descriptor of descriptors) {
    const architecture = await resolveArchitecture(source, descriptor.name);
    assessments.push({
      descriptor,
      architecture,
      fit: predictFit(descriptor.sizeBytes, architecture, context, freeVramMib),
    });
  }
  return assessments;
}

/**
 * Builds the plan: filters does-not-fit candidates (unless forced) and
 * orders the rest largest first.
 *
 * @param assessments - Every assessed candidate.
 * @param options - Force flag plus unit count and token cap for the
 *   estimate.
 * @returns The plan. "unknown" fit runs (measurement decides); only a
 *   confident does-not-fit is filtered without --force.
 */
export function buildRunPlan(
  assessments: readonly CandidateAssessment[],
  options: { readonly force: boolean; readonly unitsPerCandidate: number; readonly maxTokens: number },
): RunPlan {
  const included: CandidateAssessment[] = [];
  const skipped: { assessment: CandidateAssessment; reason: string }[] = [];
  for (const assessment of assessments) {
    if (assessment.fit.verdict === 'does-not-fit' && !options.force) {
      skipped.push({ assessment, reason: `${assessment.fit.reason}; rerun with --force to attempt it anyway` });
    } else {
      included.push(assessment);
    }
  }
  included.sort((a, b) => b.descriptor.sizeBytes - a.descriptor.sizeBytes);
  return {
    included,
    skipped,
    unitsPerCandidate: options.unitsPerCandidate,
    estimatedSecondsPerCandidate: estimateSeconds(options.unitsPerCandidate, options.maxTokens),
  };
}

/**
 * Renders the plan for the terminal, printed before execution.
 *
 * @param plan - The built plan.
 * @param packName - Task pack name for the heading.
 * @returns Multi-line text: what runs (in order), what was skipped and
 *   why, and the rough total estimate.
 */
export function renderRunPlan(plan: RunPlan, packName: string): string {
  const lines: string[] = [];
  const mib = (n: number | null): string => (n === null ? 'peak unknown' : `predicted peak ${n.toFixed(0)} MiB`);
  lines.push(`plan: ${packName}, ${String(plan.included.length)} candidate${plan.included.length === 1 ? '' : 's'}, ${String(plan.unitsPerCandidate)} units each`);
  for (const { descriptor, fit } of plan.included) {
    lines.push(
      `  run  ${descriptor.name.padEnd(24)} ${(descriptor.sizeBytes / (1024 * 1024)).toFixed(0).padStart(7)} MiB weights, ${mib(fit.predictedPeakMib)}, fit: ${fit.verdict}`,
    );
  }
  for (const { assessment, reason } of plan.skipped) {
    lines.push(`  skip ${assessment.descriptor.name.padEnd(24)} ${reason}`);
  }
  const totalSeconds = plan.estimatedSecondsPerCandidate * plan.included.length;
  lines.push(
    `  estimate: ~${String(Math.round(totalSeconds / 60))} min total (${String(plan.estimatedSecondsPerCandidate)}s per candidate at a fixed pre-measurement guess; refined after the first model completes)`,
  );
  return lines.join('\n');
}

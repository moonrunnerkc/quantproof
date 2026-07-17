/**
 * Fit prediction: estimates whether a candidate fits in free VRAM
 * before minutes are spent loading it. Deliberately conservative (a
 * false "fits" costs a crash cycle; a false "does not fit" only costs
 * a --force flag). Every verdict carries the numbers behind it, and
 * the predicted peak is stored so reports can show predicted versus
 * measured.
 */

import type { ModelArchitecture } from './gguf-metadata.js';

const MIB = 1024 * 1024;
/** Fixed allowance for compute buffers, graph, and scratch space. */
export const COMPUTE_OVERHEAD_MIB = 1024;
/** KV cache element size: f16, Ollama's default cache type. */
const KV_ELEMENT_BYTES = 2;
/** Fraction of free VRAM a candidate may claim and still count as fitting. */
const FREE_VRAM_HEADROOM = 0.95;

/** Per-candidate fit verdict with its arithmetic. */
export interface FitPrediction {
  readonly verdict: 'fits' | 'does-not-fit' | 'unknown' | 'not-applicable';
  /** One sentence explaining the verdict. */
  readonly reason: string;
  /** Weights + KV + overhead; null when architecture is unknown. */
  readonly predictedPeakMib: number | null;
  readonly weightsMib: number;
  /** Null when the architecture (and so the KV math) is unknown. */
  readonly kvCacheMib: number | null;
  readonly overheadMib: number;
  /** Free VRAM sampled at plan time; null when unmeasurable. */
  readonly freeVramMib: number | null;
}

/**
 * The fit verdict for API-backend candidates: inference runs on the
 * provider's hardware, so local fit is not a question, not an unknown.
 *
 * @returns A prediction whose verdict is "not-applicable".
 */
export function notApplicableFit(): FitPrediction {
  return {
    verdict: 'not-applicable',
    reason: 'API backend: inference runs on Anthropic hardware, so local fit does not apply',
    predictedPeakMib: null,
    weightsMib: 0,
    kvCacheMib: null,
    overheadMib: 0,
    freeVramMib: null,
  };
}

/**
 * KV cache size for a context length, in MiB.
 *
 * blocks x kv_heads x (key_len + value_len) x context x 2 bytes (f16),
 * covering both the K and the V tensors via key_len + value_len.
 *
 * @param arch - Model architecture fields.
 * @param context - Requested context length in tokens.
 * @returns KV cache MiB.
 */
export function kvCacheMib(arch: ModelArchitecture, context: number): number {
  return (
    (arch.blockCount * arch.kvHeadCount * (arch.keyLength + arch.valueLength) * context * KV_ELEMENT_BYTES) /
    MIB
  );
}

/**
 * Predicts whether a candidate fits in free VRAM at a context length.
 *
 * @param sizeBytes - Weights file size on disk.
 * @param arch - Architecture metadata, or null when unresolvable; a
 *   null architecture yields verdict "unknown" (attempt with --force),
 *   never a throw.
 * @param context - Requested context length in tokens.
 * @param freeVramMib - Free VRAM sampled at plan time, or null when no
 *   GPU telemetry exists; prediction then reports the peak it computed
 *   with verdict "unknown".
 * @returns The prediction with all inputs echoed for the report.
 */
export function predictFit(
  sizeBytes: number,
  arch: ModelArchitecture | null,
  context: number,
  freeVramMib: number | null,
): FitPrediction {
  const weightsMib = sizeBytes / MIB;
  if (arch === null) {
    return {
      verdict: 'unknown',
      reason: 'architecture metadata unavailable, so the KV cache cannot be estimated; attempt with --force',
      predictedPeakMib: null,
      weightsMib,
      kvCacheMib: null,
      overheadMib: COMPUTE_OVERHEAD_MIB,
      freeVramMib,
    };
  }
  const kv = kvCacheMib(arch, context);
  const predictedPeakMib = weightsMib + kv + COMPUTE_OVERHEAD_MIB;
  if (freeVramMib === null) {
    return {
      verdict: 'unknown',
      reason: 'free VRAM could not be sampled (no GPU telemetry), so no fit verdict is possible',
      predictedPeakMib,
      weightsMib,
      kvCacheMib: kv,
      overheadMib: COMPUTE_OVERHEAD_MIB,
      freeVramMib,
    };
  }
  const budget = freeVramMib * FREE_VRAM_HEADROOM;
  const fits = predictedPeakMib <= budget;
  return {
    verdict: fits ? 'fits' : 'does-not-fit',
    reason: fits
      ? `predicted peak ${predictedPeakMib.toFixed(0)} MiB is within ${budget.toFixed(0)} MiB (95% of ${freeVramMib.toFixed(0)} MiB free)`
      : `predicted peak ${predictedPeakMib.toFixed(0)} MiB exceeds ${budget.toFixed(0)} MiB (95% of ${freeVramMib.toFixed(0)} MiB free)`,
    predictedPeakMib,
    weightsMib,
    kvCacheMib: kv,
    overheadMib: COMPUTE_OVERHEAD_MIB,
    freeVramMib,
  };
}

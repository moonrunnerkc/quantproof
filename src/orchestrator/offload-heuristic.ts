/**
 * Partial-offload detection: a heuristic flag with its reasoning, not
 * a hard claim. Ollama decides its own GPU offload split, so a model
 * can silently run partly on CPU; the telemetry catches the two
 * symptoms build plan 5.4 names: throughput collapse relative to
 * similar-size candidates, and peak VRAM plateauing well under
 * prediction while the model still runs.
 */

/** What the heuristic needs to know about one completed candidate. */
export interface OffloadInputs {
  readonly candidateId: string;
  readonly modelName: string;
  readonly sizeBytes: number;
  readonly predictedPeakMib: number | null;
  readonly measuredPeakMib: number | null;
  readonly tokensPerSecondMedian: number | null;
}

/** A fired flag with the reasoning that goes into the record. */
export interface OffloadSuspect {
  readonly candidateId: string;
  readonly reason: string;
}

/** Peak under this fraction of prediction looks like a CPU/GPU split. */
const VRAM_PLATEAU_FRACTION = 0.6;
/** Throughput under this fraction of similar-size peers looks split. */
const THROUGHPUT_COLLAPSE_FRACTION = 0.25;
/** "Similar size" band around a candidate, by weights bytes. */
const SIZE_BAND = { lower: 0.5, upper: 2 };

/**
 * Flags candidates whose measurements suggest a CPU/GPU split.
 *
 * @param candidates - Completed candidates with their measurements;
 *   pass only candidates that actually ran to completion.
 * @returns Zero or more suspects, each with a one-sentence reason
 *   naming the numbers that fired the rule.
 */
export function detectOffloadSuspects(candidates: readonly OffloadInputs[]): OffloadSuspect[] {
  const suspects: OffloadSuspect[] = [];
  for (const candidate of candidates) {
    if (
      candidate.measuredPeakMib !== null &&
      candidate.predictedPeakMib !== null &&
      candidate.measuredPeakMib < candidate.predictedPeakMib * VRAM_PLATEAU_FRACTION
    ) {
      suspects.push({
        candidateId: candidate.candidateId,
        reason: `suspected cpu/gpu split: measured peak ${candidate.measuredPeakMib.toFixed(0)} MiB plateaued under ${String(Math.round(VRAM_PLATEAU_FRACTION * 100))}% of the predicted ${candidate.predictedPeakMib.toFixed(0)} MiB while the model still ran`,
      });
      continue;
    }
    if (candidate.tokensPerSecondMedian === null) {
      continue;
    }
    const peers = candidates.filter(
      (other) =>
        other.candidateId !== candidate.candidateId &&
        other.tokensPerSecondMedian !== null &&
        other.sizeBytes >= candidate.sizeBytes * SIZE_BAND.lower &&
        other.sizeBytes <= candidate.sizeBytes * SIZE_BAND.upper,
    );
    if (peers.length === 0) {
      continue;
    }
    const bestPeer = Math.max(...peers.map((p) => p.tokensPerSecondMedian ?? 0));
    if (candidate.tokensPerSecondMedian < bestPeer * THROUGHPUT_COLLAPSE_FRACTION) {
      const names = peers.map((p) => p.modelName).join(', ');
      suspects.push({
        candidateId: candidate.candidateId,
        reason: `suspected cpu/gpu split: ${candidate.tokensPerSecondMedian.toFixed(1)} tok/s is under ${String(Math.round(THROUGHPUT_COLLAPSE_FRACTION * 100))}% of the ${bestPeer.toFixed(1)} tok/s that similar-size candidates (${names}) reached`,
      });
    }
  }
  return suspects;
}

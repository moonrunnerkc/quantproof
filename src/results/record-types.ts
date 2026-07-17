/**
 * Result record types: the single source of truth for what a run
 * produces. Everything the report renders and everything a future
 * re-score needs (raw outputs, exact request options) lives in these
 * shapes; the store persists them verbatim.
 */

import type { GenerationParams } from '../tasks/task-schema.js';

/** One invocation of `quantproof run`. */
export interface RunRecord {
  readonly id: string;
  /** Wall-clock start, epoch milliseconds. */
  readonly createdAtMs: number;
  readonly packName: string;
  readonly packDir: string;
  readonly taskType: string;
  /** Primary scorer name; gate names live in score details. */
  readonly scorerName: string;
  /** Generation params from the manifest, applied to every candidate. */
  readonly generation: GenerationParams;
  /** e.g. "ollama 0.23.1". */
  readonly backendVersion: string;
  readonly gpuName: string | null;
  readonly driverVersion: string | null;
  /** False when the VRAM probe could not run; reason says why. */
  readonly vramAvailable: boolean;
  readonly vramUnavailableReason: string | null;
}

/** One model/quant evaluated within a run. */
export interface CandidateRecord {
  readonly id: string;
  readonly runId: string;
  readonly modelName: string;
  readonly digest: string;
  readonly quantization: string | null;
  readonly parameterSize: string | null;
  readonly sizeBytes: number;
}

/** Final measurements for a candidate, written when it finishes. */
export interface CandidateOutcome {
  readonly status: 'completed' | 'failed';
  readonly peakVramMib: number | null;
  /** VRAM timeline as [offsetMs, usedMib] pairs; empty when unmeasured. */
  readonly vramSamples: readonly (readonly [number, number])[];
  /**
   * True when every example produced byte-identical output across all
   * repetitions; false flags backend nondeterminism despite the fixed
   * seed. Null when repetitions never completed.
   */
  readonly deterministic: boolean | null;
}

/** One planned generation: example x repetition for a candidate. */
export interface WorkUnitRecord {
  readonly id: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly exampleId: string;
  /** 1-based repetition index. */
  readonly repetition: number;
}

export type WorkUnitStatus = 'pending' | 'completed' | 'failed';

/** The measured result of one generation, stored in full. */
export interface GenerationRecord {
  readonly id: string;
  readonly workUnitId: string;
  /** Complete raw model output; re-scoring depends on this. */
  readonly output: string;
  readonly doneReason: string;
  readonly ttftMs: number | null;
  readonly tokensPerSecond: number | null;
  readonly wallMs: number;
  readonly tokenCount: number;
  readonly promptTokenCount: number | null;
  readonly outputTokenCount: number | null;
  /** Exact request options sent to the backend, for reproducibility. */
  readonly requestOptions: Readonly<Record<string, unknown>>;
}

/** The score assigned to one generation. */
export interface UnitScoreRecord {
  readonly id: string;
  readonly workUnitId: string;
  /** Primary scorer name; the details carry gate records. */
  readonly scorerName: string;
  readonly score: number;
  readonly pass: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

/** A completed unit joined with its generation and score, for reports. */
export interface UnitResult {
  readonly unit: WorkUnitRecord;
  readonly status: WorkUnitStatus;
  readonly failureReason: string | null;
  readonly generation: GenerationRecord | null;
  readonly score: UnitScoreRecord | null;
}

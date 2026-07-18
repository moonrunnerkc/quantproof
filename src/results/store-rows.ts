/**
 * Row-to-record mapping for the results database. Kept separate from
 * the statement layer so each stays under the file cap and the record
 * shapes in record-types.ts remain the single source of truth.
 */

import type {
  CandidateResult,
  CandidateStatus,
  GenerationRecord,
  RunRecord,
  UnitResult,
  UnitScoreRecord,
  WorkUnitStatus,
} from './record-types.js';

/** Raw work_units row. */
export interface UnitRow {
  id: string;
  run_id: string;
  candidate_id: string;
  example_id: string;
  repetition: number;
  status: WorkUnitStatus;
  failure_reason: string | null;
}

type Row = Record<string, unknown>;

/** Maps a runs row to its record. */
export function runFromRow(row: Row): RunRecord {
  return {
    id: row['id'] as string,
    createdAtMs: row['created_at_ms'] as number,
    packName: row['pack_name'] as string,
    packDir: row['pack_dir'] as string,
    taskType: row['task_type'] as string,
    scorerName: row['scorer_name'] as string,
    generation: JSON.parse(row['generation_json'] as string) as RunRecord['generation'],
    backendVersion: row['backend_version'] as string,
    gpuName: row['gpu_name'] as string | null,
    driverVersion: row['driver_version'] as string | null,
    vramAvailable: row['vram_available'] === 1,
    vramUnavailableReason: row['vram_unavailable_reason'] as string | null,
    packProvenance:
      row['provenance_json'] == null
        ? null
        : (JSON.parse(row['provenance_json'] as string) as RunRecord['packProvenance']),
    plan: JSON.parse(row['plan_json'] as string) as RunRecord['plan'],
  };
}

/** Maps a candidates row to its result view. */
export function candidateFromRow(row: Row): CandidateResult {
  return {
    record: {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      modelName: row['model_name'] as string,
      digest: row['digest'] as string,
      quantization: row['quantization'] as string | null,
      parameterSize: row['parameter_size'] as string | null,
      sizeBytes: row['size_bytes'] as number,
      fitVerdict: row['fit_verdict'] as CandidateResult['record']['fitVerdict'],
      predictedPeakMib: row['predicted_peak_mib'] as number | null,
      fitDetails: JSON.parse(row['fit_details_json'] as string) as Record<string, unknown>,
    },
    status: row['status'] as CandidateStatus,
    statusReason: row['status_reason'] as string | null,
    peakVramMib: row['peak_vram_mib'] as number | null,
    deterministic:
      row['deterministic'] === null ? null : row['deterministic'] === 1,
    offloadSuspectReason: row['offload_suspect_reason'] as string | null,
  };
}

/** Maps a work unit row plus optional generation/score rows. */
export function unitResultFromRows(
  unit: UnitRow,
  generation: Row | undefined,
  score: Row | undefined,
): UnitResult {
  const generationRecord: GenerationRecord | null =
    generation === undefined
      ? null
      : {
          id: generation['id'] as string,
          workUnitId: unit.id,
          output: generation['output'] as string,
          doneReason: generation['done_reason'] as string,
          ttftMs: generation['ttft_ms'] as number | null,
          tokensPerSecond: generation['tokens_per_second'] as number | null,
          wallMs: generation['wall_ms'] as number,
          tokenCount: generation['token_count'] as number,
          promptTokenCount: generation['prompt_token_count'] as number | null,
          outputTokenCount: generation['output_token_count'] as number | null,
          requestOptions: JSON.parse(generation['request_options_json'] as string) as Record<string, unknown>,
        };
  const scoreRecord: UnitScoreRecord | null =
    score === undefined
      ? null
      : {
          id: score['id'] as string,
          workUnitId: unit.id,
          scorerName: score['scorer_name'] as string,
          score: score['score'] as number,
          pass: score['pass'] === 1,
          details: JSON.parse(score['details_json'] as string) as Record<string, unknown>,
        };
  return {
    unit: {
      id: unit.id,
      runId: unit.run_id,
      candidateId: unit.candidate_id,
      exampleId: unit.example_id,
      repetition: unit.repetition,
    },
    status: unit.status,
    failureReason: unit.failure_reason,
    generation: generationRecord,
    score: scoreRecord,
  };
}

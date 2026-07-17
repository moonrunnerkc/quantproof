/**
 * Shared constructors for report-layer tests: unit results, candidate
 * views, and full aggregates with known numbers, so each test states
 * only what it cares about.
 */

import type { CandidateAggregate, RunSummary } from '../../src/report/aggregate.js';
import type { CandidateResult, RunRecord, UnitResult } from '../../src/results/record-types.js';

/** Options for a constructed unit result. */
export interface UnitOptions {
  readonly candidateId?: string;
  readonly output?: string;
  readonly ttftMs?: number | null;
  readonly tps?: number | null;
  readonly status?: 'completed' | 'failed' | 'pending' | 'skipped';
  readonly pass?: boolean;
  /** Sets details.failedGate, marking a gate failure on this unit. */
  readonly failedGate?: string;
}

/** Builds one unit result with score and generation defaults. */
export function unitResult(
  exampleId: string,
  repetition: number,
  score: number,
  overrides: UnitOptions = {},
): UnitResult {
  const status = overrides.status ?? 'completed';
  const candidateId = overrides.candidateId ?? 'c';
  const id = `${candidateId}-${exampleId}-${String(repetition)}`;
  if (status !== 'completed') {
    return {
      unit: { id, runId: 'r', candidateId, exampleId, repetition },
      status,
      failureReason: status === 'failed' ? 'boom' : null,
      generation: null,
      score: null,
    };
  }
  return {
    unit: { id, runId: 'r', candidateId, exampleId, repetition },
    status,
    failureReason: null,
    generation: {
      id: `g-${id}`, workUnitId: id, output: overrides.output ?? `out-${exampleId}`,
      doneReason: 'stop', ttftMs: overrides.ttftMs ?? 100, tokensPerSecond: overrides.tps ?? 40,
      wallMs: 500, tokenCount: 10, promptTokenCount: 20, outputTokenCount: 10, requestOptions: {},
    },
    score: {
      id: `s-${id}`, workUnitId: id, scorerName: 'field-f1', score,
      pass: overrides.pass ?? score === 1,
      details: { failedGate: overrides.failedGate ?? null },
    },
  };
}

/** Builds a run record with realistic environment defaults. */
export function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1', createdAtMs: Date.UTC(2026, 6, 16, 3, 24, 0),
    packName: 'invoice-extraction', packDir: './examples/invoice-extraction',
    taskType: 'extraction', scorerName: 'field-f1',
    generation: { context: 4096, max_tokens: 512, temperature: 0, seed: 42, runs_per_example: 3 },
    backendVersion: 'ollama 0.23.1',
    gpuName: 'NVIDIA GeForce RTX 5070', driverVersion: '580.65.06',
    vramAvailable: true, vramUnavailableReason: null,
    plan: {
      explicitModel: null, configPath: null, configFingerprint: null,
      packFingerprint: 'pack-fp', limit: null, force: false,
    },
    ...overrides,
  };
}

/** Builds a completed candidate view for store-level tests. */
export function candidateResult(
  id: string,
  modelName: string,
  overrides: Partial<Omit<CandidateResult, 'record'>> & {
    readonly record?: Partial<CandidateResult['record']>;
  } = {},
): CandidateResult {
  const { record, ...rest } = overrides;
  return {
    record: {
      id, runId: 'run-1', modelName, digest: `${id}-digest-0123456789ab`,
      quantization: 'Q4_K_M', parameterSize: '1B', sizeBytes: 800_000_000,
      fitVerdict: 'fits', predictedPeakMib: 4000, fitDetails: {},
      ...record,
    },
    status: 'completed', statusReason: null, peakVramMib: 4200,
    deterministic: true, offloadSuspectReason: null,
    ...rest,
  };
}

/** Options for a directly constructed aggregate. */
export interface AggregateOptions {
  readonly quality?: number | null;
  readonly vram?: number | null;
  readonly tps?: number | null;
  readonly status?: CandidateAggregate['status'];
  readonly statusReason?: string | null;
  readonly gatesPassed?: boolean | null;
  readonly gateFailureCounts?: Readonly<Record<string, number>>;
  readonly sizeBytes?: number;
  readonly predictedPeakMib?: number | null;
  readonly offloadSuspectReason?: string | null;
  readonly quantization?: string | null;
  readonly passRate?: number | null;
  readonly summary?: Partial<RunSummary>;
}

/**
 * Builds a candidate aggregate with the numbers a test declares and
 * consistent defaults everywhere else.
 */
export function makeAggregate(modelName: string, opts: AggregateOptions = {}): CandidateAggregate {
  const quality = opts.quality === undefined ? 0.9 : opts.quality;
  const vram = opts.vram === undefined ? 4200 : opts.vram;
  const tps = opts.tps === undefined ? 40 : opts.tps;
  const predicted = opts.predictedPeakMib === undefined ? 4000 : opts.predictedPeakMib;
  const summary: RunSummary = {
    completed: quality === null ? 0 : 6,
    failed: 0, pending: 0, skipped: quality === null ? 6 : 0,
    meanScore: quality,
    passRate: opts.passRate === undefined ? (quality === null ? null : 1) : opts.passRate,
    repetitions: quality === null ? [] : [
      { repetition: 1, meanScore: quality },
      { repetition: 2, meanScore: quality },
    ],
    scoreSpread: quality === null ? null : { min: quality, max: quality },
    ttftMedianMs: quality === null ? null : 250,
    ttftSpreadMs: quality === null ? null : { min: 220, max: 280 },
    tokensPerSecondMedian: tps,
    tokensPerSecondSpread: tps === null ? null : { min: tps - 2, max: tps + 2 },
    wallMsTotal: 3000,
    outputsDeterministic: quality === null ? null : true,
    ...opts.summary,
  };
  return {
    candidate: {
      id: `cand-${modelName}`, runId: 'run-1', modelName,
      digest: `${modelName.replace(/[^a-z0-9]/gi, '')}0123456789abcdef`,
      quantization: opts.quantization === undefined ? 'Q4_K_M' : opts.quantization,
      parameterSize: '1B',
      sizeBytes: opts.sizeBytes ?? 800_000_000,
      fitVerdict: 'fits', predictedPeakMib: predicted, fitDetails: {},
    },
    status: opts.status ?? 'completed',
    statusReason: opts.statusReason ?? null,
    offloadSuspectReason: opts.offloadSuspectReason ?? null,
    summary,
    measuredPeakMib: vram,
    predictedPeakMib: predicted,
    vramDeltaPercent:
      vram === null || predicted === null ? null : ((vram - predicted) / predicted) * 100,
    gatesPassed: opts.gatesPassed === undefined ? (quality === null ? null : true) : opts.gatesPassed,
    gateFailureCounts: opts.gateFailureCounts ?? {},
  };
}

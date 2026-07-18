/**
 * Sweep executor: candidates run strictly one at a time with isolation
 * between them (forced unload happens in the candidate runner; here
 * VRAM is polled back to baseline and a cooldown passes before the
 * next model). Journaling is immediate throughout; killing the process
 * mid-sweep must leave every finished unit readable, which is what
 * resume builds on.
 */

import { randomUUID } from 'node:crypto';
import type { BackendAdapter } from '../backends/backend-adapter.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { bindPackScorers } from '../scoring/plan-check.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';
import { startVramProbe, queryVramOnce } from '../telemetry/vram-probe.js';
import type { GpuInfo, VramProbe, VramProbeResult, VramSnapshot } from '../telemetry/vram-probe.js';
import { summarizeRun } from '../report/aggregate.js';
import type { RunSummary } from '../report/aggregate.js';
import { estimateSeconds } from './run-planner.js';
import type { RunPlan } from './run-planner.js';
import { runCandidate } from './candidate-runner.js';
import { detectOffloadSuspects } from './offload-heuristic.js';
import type {
  CandidateRecord, PlanSnapshot, RunRecord, UnitResult, WorkUnitRecord,
} from '../results/record-types.js';
import type { RunStore } from '../results/run-store.js';

/** Dependencies and pacing hooks; only adapter and store are required. */
export interface SweepOptions {
  readonly adapter: BackendAdapter;
  readonly store: RunStore;
  readonly startProbe?: () => VramProbe;
  readonly sampleVram?: () => VramSnapshot | null;
  readonly onProgress?: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cooldownMs?: number;
  readonly baselineTimeoutMs?: number;
  readonly backoffMs?: number;
}

/** A journaled sweep ready to execute: the run row plus each candidate
 * with its still-pending units. */
export interface PreparedSweep {
  readonly run: RunRecord;
  readonly entries: readonly {
    readonly candidate: CandidateRecord;
    readonly units: readonly WorkUnitRecord[];
  }[];
}

/** One candidate's rendered-ready outcome. */
export interface CandidateSweepOutcome {
  readonly candidate: CandidateRecord;
  readonly status: 'completed' | 'failed' | 'oom';
  readonly statusReason: string | null;
  /** Set when the partial-offload heuristic fired for this candidate. */
  readonly offloadSuspectReason: string | null;
  readonly summary: RunSummary;
  readonly vram: VramProbeResult;
  readonly results: readonly UnitResult[];
}

/** The finished sweep. */
export interface SweepOutcome {
  readonly run: RunRecord;
  readonly candidates: readonly CandidateSweepOutcome[];
}

/**
 * Creates the run, candidate, and work-unit rows for a fresh sweep.
 *
 * @param store - Open results store.
 * @param pack - Loaded (and possibly limited) task pack.
 * @param packDir - Pack directory as invoked, for the repro line.
 * @param plan - The built plan; included candidates become rows.
 * @param snapshot - Invocation snapshot for exact resume.
 * @param env - Backend version and GPU identity for the run row.
 * @returns The prepared sweep with every unit pending.
 */
export function prepareSweepJournal(
  store: RunStore,
  pack: LoadedTaskPack,
  packDir: string,
  plan: RunPlan,
  snapshot: PlanSnapshot,
  env: { readonly backendVersion: string; readonly gpu: GpuInfo | null; readonly vramUnavailableReason: string | null },
): PreparedSweep {
  const run: RunRecord = {
    id: randomUUID(),
    createdAtMs: Date.now(),
    packName: pack.manifest.name,
    packDir,
    taskType: pack.manifest.type,
    scorerName: pack.manifest.scorer,
    generation: pack.manifest.generation,
    backendVersion: env.backendVersion,
    gpuName: env.gpu?.name ?? null,
    driverVersion: env.gpu?.driverVersion ?? null,
    vramAvailable: env.gpu !== null,
    vramUnavailableReason: env.vramUnavailableReason,
    packProvenance: pack.manifest.provenance,
    plan: snapshot,
  };
  store.createRun(run);
  const entries = plan.included.map(({ descriptor, fit }) => {
    const candidate: CandidateRecord = {
      id: randomUUID(),
      runId: run.id,
      modelName: descriptor.name,
      digest: descriptor.digest,
      quantization: descriptor.quantization,
      parameterSize: descriptor.parameterSize,
      sizeBytes: descriptor.sizeBytes,
      fitVerdict: fit.verdict,
      predictedPeakMib: fit.predictedPeakMib,
      fitDetails: { ...fit },
    };
    store.createCandidate(candidate);
    const units: WorkUnitRecord[] = pack.examples.flatMap((example) =>
      Array.from({ length: pack.manifest.generation.runs_per_example }, (_, i) => ({
        id: randomUUID(), runId: run.id, candidateId: candidate.id,
        exampleId: example.id, repetition: i + 1,
      })),
    );
    store.createWorkUnits(units);
    return { candidate, units };
  });
  return { run, entries };
}

async function settleToBaseline(
  baseline: VramSnapshot | null,
  options: Required<Pick<SweepOptions, 'sleep' | 'cooldownMs' | 'baselineTimeoutMs'>> & SweepOptions,
  progress: (line: string) => void,
): Promise<void> {
  const sample = options.sampleVram ?? (() => queryVramOnce());
  if (baseline !== null) {
    const deadline =
      options.baselineTimeoutMs;
    let waited = 0;
    for (;;) {
      const current = sample();
      if (current === null || current.usedMib <= baseline.usedMib + 256) {
        break;
      }
      if (waited >= deadline) {
        progress(
          `warning: VRAM did not return to baseline after unload (${String(current.usedMib)} MiB used vs baseline ${String(baseline.usedMib)} MiB); measurements for the next candidate may be inflated`,
        );
        break;
      }
      await options.sleep(500);
      waited += 500;
    }
  }
  await options.sleep(options.cooldownMs);
}

/**
 * Executes a prepared sweep sequentially with isolation between
 * candidates, then runs the partial-offload heuristic across the
 * completed candidates.
 *
 * @param pack - The loaded task pack the journal was built from.
 * @param prepared - Fresh journal rows or a resume's pending view.
 * @param options - Adapter, store, probes, and pacing hooks.
 * @returns Every candidate's outcome in execution order.
 */
export async function executeSweep(
  pack: LoadedTaskPack,
  prepared: PreparedSweep,
  options: SweepOptions,
): Promise<SweepOutcome> {
  registerBuiltinScorers();
  const progress = options.onProgress ?? ((): void => undefined);
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const sample = options.sampleVram ?? (() => queryVramOnce());
  const scorers = bindPackScorers(pack);

  const outcomes: CandidateSweepOutcome[] = [];
  let measuredTps: number | null = null;
  for (const [index, entry] of prepared.entries.entries()) {
    const remaining = prepared.entries.length - index;
    const perCandidate = estimateSeconds(
      entry.units.length, pack.manifest.generation.max_tokens, measuredTps ?? undefined,
    );
    progress(
      `candidate ${String(index + 1)}/${String(prepared.entries.length)}: ${entry.candidate.modelName} (~${String(Math.round((perCandidate * remaining) / 60))} min remaining${measuredTps === null ? ', pre-measurement estimate' : ''})`,
    );
    const baseline = sample();
    const probe = (options.startProbe ?? startVramProbe)();
    const result = await runCandidate(pack, entry.candidate, entry.units, {
      adapter: options.adapter,
      store: options.store,
      probe,
      scorers,
      onProgress: progress,
      sleep,
      backoffMs: options.backoffMs ?? 1000,
    });
    const allUnits = options.store.listUnitResults(prepared.run.id)
      .filter((r) => r.unit.candidateId === entry.candidate.id);
    const summary = summarizeRun(allUnits);
    const firstSampleAt = result.vram.available ? (result.vram.samples[0]?.at ?? 0) : 0;
    options.store.finishCandidate(entry.candidate.id, {
      status: result.status,
      statusReason: result.statusReason,
      peakVramMib: result.vram.available ? result.vram.peakMib : null,
      vramSamples: result.vram.available
        ? result.vram.samples.map((s) => [Math.round(s.at - firstSampleAt), s.usedMib] as const)
        : [],
      deterministic: summary.outputsDeterministic,
    });
    outcomes.push({
      candidate: entry.candidate,
      status: result.status,
      statusReason: result.statusReason,
      offloadSuspectReason: null,
      summary,
      vram: result.vram,
      results: allUnits,
    });
    measuredTps = measuredTps ?? summary.tokensPerSecondMedian;
    if (index < prepared.entries.length - 1) {
      await settleToBaseline(baseline, {
        ...options, sleep,
        cooldownMs: options.cooldownMs ?? 3000,
        baselineTimeoutMs: options.baselineTimeoutMs ?? 15000,
      }, progress);
    }
  }

  const suspects = detectOffloadSuspects(
    outcomes
      .filter((o) => o.status === 'completed')
      .map((o) => ({
        candidateId: o.candidate.id,
        modelName: o.candidate.modelName,
        sizeBytes: o.candidate.sizeBytes,
        predictedPeakMib: o.candidate.predictedPeakMib,
        measuredPeakMib: o.vram.available ? o.vram.peakMib : null,
        tokensPerSecondMedian: o.summary.tokensPerSecondMedian,
      })),
  );
  for (const suspect of suspects) {
    options.store.flagOffloadSuspect(suspect.candidateId, suspect.reason);
    progress(`flag: ${suspect.reason}`);
  }
  const suspectById = new Map(suspects.map((s) => [s.candidateId, s.reason]));
  return {
    run: prepared.run,
    candidates: outcomes.map((outcome) => ({
      ...outcome,
      offloadSuspectReason: suspectById.get(outcome.candidate.id) ?? null,
    })),
  };
}

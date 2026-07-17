/**
 * Single-model run executor: one task pack x one model x all examples
 * x runs_per_example, sequentially, with one untimed warmup before the
 * timed units, probes attached across the whole model lifecycle, and a
 * forced unload afterward. Every completed unit is journaled to the
 * store immediately; the process dying mid-run must leave every
 * finished unit readable.
 */

import { randomUUID } from 'node:crypto';
import type { BackendAdapter, ModelDescriptor } from '../backends/backend-adapter.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { scoreWithGates } from '../scoring/gate-composition.js';
import type { BoundScorer } from '../scoring/gate-composition.js';
import { getScorer } from '../scoring/scorer-registry.js';
import { renderPrompt } from '../tasks/prompt-template.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';
import type { TaskExample } from '../tasks/example-loader.js';
import { observeGeneration } from '../telemetry/timing-probe.js';
import type { ObservedGeneration } from '../telemetry/timing-probe.js';
import { startVramProbe } from '../telemetry/vram-probe.js';
import type { VramProbe, VramProbeResult } from '../telemetry/vram-probe.js';
import { summarizeRun } from '../report/aggregate.js';
import type { RunSummary } from '../report/aggregate.js';
import type { CandidateRecord, RunRecord, UnitResult, WorkUnitRecord } from '../results/record-types.js';
import type { RunStore } from '../results/run-store.js';

/** Dependencies and hooks for a run. Only adapter and store are required. */
export interface ExecutorOptions {
  readonly adapter: BackendAdapter;
  readonly store: RunStore;
  /** Probe factory, overridable in tests; defaults to startVramProbe. */
  readonly startProbe?: () => VramProbe;
  /** Called once per warmup and per unit with a printable line. */
  readonly onProgress?: (line: string) => void;
  /** Clock for the run record; defaults to Date.now. */
  readonly now?: () => number;
}

/** Everything a caller needs to render the result of a finished run. */
export interface SingleModelRunOutcome {
  readonly run: RunRecord;
  readonly candidate: CandidateRecord;
  readonly results: readonly UnitResult[];
  readonly summary: RunSummary;
  readonly vram: VramProbeResult;
}

const TRANSPORT_RETRIES = 2;

function isTransportError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('cannot reach Ollama');
}

async function generateWithRetry(
  adapter: BackendAdapter,
  model: string,
  pack: LoadedTaskPack,
  example: TaskExample,
): Promise<ObservedGeneration> {
  const request = {
    prompt: renderPrompt(pack.promptTemplate, example.input),
    context: pack.manifest.generation.context,
    maxTokens: pack.manifest.generation.max_tokens,
    temperature: pack.manifest.generation.temperature,
    seed: pack.manifest.generation.seed,
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await observeGeneration(adapter.generate(model, request));
    } catch (err) {
      if (!isTransportError(err) || attempt >= TRANSPORT_RETRIES) {
        throw err;
      }
    }
  }
}

function boundScorers(pack: LoadedTaskPack): { primary: BoundScorer; gates: readonly BoundScorer[] } {
  registerBuiltinScorers();
  return {
    primary: { name: pack.manifest.scorer, scorer: getScorer(pack.manifest.scorer), params: pack.scorerParams },
    gates: pack.gates.map((g) => ({ name: g.scorer, scorer: getScorer(g.scorer), params: g.scorerParams })),
  };
}

/**
 * Runs one model against every example of a pack, runs_per_example
 * times each, and journals every result.
 *
 * @param pack - A loaded task pack.
 * @param packDir - The pack directory as given on the command line,
 *   recorded for the reproduction line.
 * @param modelName - Backend model name, e.g. "gemma3:1b".
 * @param options - Adapter, store, and optional hooks.
 * @returns The persisted records plus the aggregated summary.
 * @throws When the backend is unreachable or the model cannot be made
 *   available; unit-level failures are journaled, not thrown. The
 *   model is force-unloaded even when the run throws.
 */
export async function executeSingleModelRun(
  pack: LoadedTaskPack,
  packDir: string,
  modelName: string,
  options: ExecutorOptions,
): Promise<SingleModelRunOutcome> {
  const { adapter, store } = options;
  const progress = options.onProgress ?? ((): void => undefined);
  const now = options.now ?? Date.now;
  const scorers = boundScorers(pack);

  const backendVersion = await adapter.version();
  const descriptor: ModelDescriptor = await adapter.ensureModelAvailable(modelName);

  const probe = (options.startProbe ?? startVramProbe)();
  const run: RunRecord = {
    id: randomUUID(),
    createdAtMs: now(),
    packName: pack.manifest.name,
    packDir,
    taskType: pack.manifest.type,
    scorerName: pack.manifest.scorer,
    generation: pack.manifest.generation,
    backendVersion,
    gpuName: probe.gpu?.name ?? null,
    driverVersion: probe.gpu?.driverVersion ?? null,
    vramAvailable: probe.gpu !== null,
    vramUnavailableReason: probe.unavailableReason,
  };
  const candidate: CandidateRecord = {
    id: randomUUID(),
    runId: run.id,
    modelName: descriptor.name,
    digest: descriptor.digest,
    quantization: descriptor.quantization,
    parameterSize: descriptor.parameterSize,
    sizeBytes: descriptor.sizeBytes,
  };
  const units: WorkUnitRecord[] = pack.examples.flatMap((example) =>
    Array.from({ length: pack.manifest.generation.runs_per_example }, (_, i) => ({
      id: randomUUID(),
      runId: run.id,
      candidateId: candidate.id,
      exampleId: example.id,
      repetition: i + 1,
    })),
  );
  let vram: VramProbeResult;
  try {
    store.createRun(run);
    store.createCandidate(candidate);
    store.createWorkUnits(units);

    await adapter.load(modelName, pack.manifest.generation.context);

    const first = pack.examples[0];
    if (first !== undefined) {
      progress(`warmup: ${first.id} (untimed)`);
      await generateWithRetry(adapter, modelName, pack, first);
    }

    const examplesById = new Map(pack.examples.map((e) => [e.id, e]));
    for (const unit of units) {
      const example = examplesById.get(unit.exampleId) as TaskExample;
      try {
        const observed = await generateWithRetry(adapter, modelName, pack, example);
        const record = scoreWithGates(observed.summary.output, example.expected, scorers.primary, scorers.gates);
        store.completeWorkUnit(
          {
            id: randomUUID(),
            workUnitId: unit.id,
            output: observed.summary.output,
            doneReason: observed.summary.doneReason,
            ttftMs: observed.timing.ttftMs,
            tokensPerSecond: observed.timing.tokensPerSecond,
            wallMs: observed.timing.wallMs,
            tokenCount: observed.timing.tokenCount,
            promptTokenCount: observed.summary.promptTokenCount,
            outputTokenCount: observed.summary.outputTokenCount,
            requestOptions: observed.summary.requestOptions,
          },
          {
            id: randomUUID(),
            workUnitId: unit.id,
            scorerName: pack.manifest.scorer,
            score: record.score,
            pass: record.pass,
            details: record.details,
          },
        );
        progress(
          `${unit.exampleId} rep ${String(unit.repetition)}: score ${record.score.toFixed(3)}` +
            ` in ${observed.timing.wallMs.toFixed(0)} ms`,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        store.failWorkUnit(unit.id, reason);
        progress(`${unit.exampleId} rep ${String(unit.repetition)}: FAILED (${reason})`);
      }
    }
  } finally {
    try {
      await adapter.unload(modelName);
    } catch {
      // The unload is best-effort cleanup; the primary error wins.
    }
    vram = await probe.stop();
  }

  const results = store.listUnitResults(run.id);
  const summary = summarizeRun(results);
  const firstSampleAt = vram.available ? (vram.samples[0]?.at ?? 0) : 0;
  store.finishCandidate(candidate.id, {
    status: summary.completed > 0 ? 'completed' : 'failed',
    peakVramMib: vram.available ? vram.peakMib : null,
    vramSamples: vram.available
      ? vram.samples.map((s) => [Math.round(s.at - firstSampleAt), s.usedMib] as const)
      : [],
    deterministic: summary.outputsDeterministic,
  });
  return { run, candidate, results, summary, vram };
}

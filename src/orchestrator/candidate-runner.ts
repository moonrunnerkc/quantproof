/**
 * Per-candidate execution: probe attached, load, one untimed warmup,
 * the unit loop with OOM classification and transport retries, forced
 * unload in a finally. One candidate failing (or OOMing) is a result;
 * the sweep above this keeps going.
 */

import { randomUUID } from 'node:crypto';
import type { BackendAdapter } from '../backends/backend-adapter.js';
import type { BoundScorer } from '../scoring/gate-composition.js';
import { scoreWithGates } from '../scoring/gate-composition.js';
import { renderPrompt } from '../tasks/prompt-template.js';
import type { TaskExample } from '../tasks/example-loader.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';
import { observeGeneration } from '../telemetry/timing-probe.js';
import type { ObservedGeneration } from '../telemetry/timing-probe.js';
import type { VramProbe, VramProbeResult } from '../telemetry/vram-probe.js';
import type { CandidateRecord, WorkUnitRecord } from '../results/record-types.js';
import type { RunStore } from '../results/run-store.js';

/** Everything a candidate execution needs from the sweep. */
export interface CandidateRunDeps {
  readonly adapter: BackendAdapter;
  readonly store: RunStore;
  readonly probe: VramProbe;
  readonly scorers: { readonly primary: BoundScorer; readonly gates: readonly BoundScorer[] };
  readonly onProgress: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Backoff base for transport retries, milliseconds. */
  readonly backoffMs: number;
}

/** How a candidate's execution ended. */
export interface CandidateRunResult {
  readonly status: 'completed' | 'failed' | 'oom';
  readonly statusReason: string | null;
  readonly vram: VramProbeResult;
}

const TRANSPORT_RETRIES = 2;

/**
 * Classifies an error as OOM-suspect: CUDA or memory allocation
 * patterns, or the backend's generic model-load failure (which on a
 * memory-starved machine is what an OOM looks like from outside).
 *
 * @param err - The thrown error.
 * @returns True when the candidate should be marked oom rather than
 *   retried or treated as a unit-level failure.
 */
export function isOomSuspect(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /out of memory|\boom\b|cuda|vram|unable to allocate|requires more (system )?memory|resource limitations|failed to load|crashed mid-generation|ended without a done line/i.test(
    message,
  );
}

function isTransportError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('cannot reach Ollama');
}

async function generateWithRetry(
  deps: CandidateRunDeps,
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
      return await observeGeneration(deps.adapter.generate(model, request));
    } catch (err) {
      if (!isTransportError(err) || attempt >= TRANSPORT_RETRIES) {
        throw err;
      }
      await deps.sleep(deps.backoffMs * (attempt + 1));
    }
  }
}

function journalCompletion(
  deps: CandidateRunDeps,
  pack: LoadedTaskPack,
  unit: WorkUnitRecord,
  example: TaskExample,
  observed: ObservedGeneration,
): number {
  const record = scoreWithGates(
    observed.summary.output, example.expected, deps.scorers.primary, deps.scorers.gates,
  );
  deps.store.completeWorkUnit(
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
  return record.score;
}

/**
 * Executes one candidate's pending units.
 *
 * OOM-suspect errors (load or mid-generation) mark the candidate oom,
 * fail the erroring unit, and skip its remaining units; OOM never
 * retries at the same configuration because it is a result. Transport
 * errors retry twice with linear backoff. The model is force-unloaded
 * on every path.
 *
 * @param pack - The loaded task pack.
 * @param candidate - The candidate's journal record.
 * @param units - Pending units to execute, in order.
 * @param deps - Adapter, store, probe, scorers, and pacing hooks.
 * @returns Terminal status with the probe result; never throws for
 *   candidate-level problems.
 */
export async function runCandidate(
  pack: LoadedTaskPack,
  candidate: CandidateRecord,
  units: readonly WorkUnitRecord[],
  deps: CandidateRunDeps,
): Promise<CandidateRunResult> {
  const model = candidate.modelName;
  const oomOut = (context: string, err: unknown): { status: 'oom'; reason: string } => {
    const reason = `oom-suspect during ${context} at context ${String(pack.manifest.generation.context)}: ${err instanceof Error ? err.message : String(err)}`;
    deps.store.skipPendingUnits(candidate.id, reason);
    deps.onProgress(`${model}: ${reason}`);
    return { status: 'oom', reason };
  };

  let terminal: { status: 'completed' | 'failed' | 'oom'; reason: string | null } | null = null;
  let completedCount = 0;
  try {
    try {
      await deps.adapter.load(model, pack.manifest.generation.context);
      const first = pack.examples.find((e) => e.id === units[0]?.exampleId) ?? pack.examples[0];
      if (first !== undefined) {
        deps.onProgress(`${model} warmup: ${first.id} (untimed)`);
        await generateWithRetry(deps, model, pack, first);
      }
    } catch (err) {
      if (isOomSuspect(err)) {
        terminal = oomOut('load/warmup', err);
      } else {
        const reason = `load failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.store.skipPendingUnits(candidate.id, reason);
        terminal = { status: 'failed', reason };
      }
    }

    if (terminal === null) {
      const examplesById = new Map(pack.examples.map((e) => [e.id, e]));
      for (const unit of units) {
        const example = examplesById.get(unit.exampleId);
        if (example === undefined) {
          deps.store.failWorkUnit(unit.id, `example ${unit.exampleId} is missing from the pack; the pack changed since planning`);
          continue;
        }
        try {
          const observed = await generateWithRetry(deps, model, pack, example);
          const score = journalCompletion(deps, pack, unit, example, observed);
          completedCount += 1;
          deps.onProgress(
            `${model} ${unit.exampleId} rep ${String(unit.repetition)}: score ${score.toFixed(3)} in ${observed.timing.wallMs.toFixed(0)} ms`,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          deps.store.failWorkUnit(unit.id, reason);
          deps.onProgress(`${model} ${unit.exampleId} rep ${String(unit.repetition)}: FAILED (${reason})`);
          if (isOomSuspect(err)) {
            terminal = oomOut('generation', err);
            break;
          }
        }
      }
    }
  } finally {
    try {
      await deps.adapter.unload(model);
    } catch {
      // Best-effort cleanup; the candidate outcome already tells the story.
    }
  }
  const vram = await deps.probe.stop();
  if (terminal === null) {
    terminal = completedCount > 0
      ? { status: 'completed', reason: null }
      : { status: 'failed', reason: 'no unit completed' };
  }
  return { status: terminal.status, statusReason: terminal.reason, vram };
}

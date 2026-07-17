/**
 * The run command: plan a sweep (or a single explicit model), print
 * the plan, execute it, and print the measured result tables.
 */

import { OllamaAdapter } from '../backends/ollama-adapter.js';
import type { ModelDescriptor } from '../backends/backend-adapter.js';
import { DEFAULT_RUN_CONFIG, loadRunConfig } from '../catalog/run-config.js';
import { resolveCandidates } from '../catalog/model-resolver.js';
import { executeSweep, prepareSweepJournal } from '../orchestrator/run-executor.js';
import { assessCandidates, buildRunPlan, renderRunPlan } from '../orchestrator/run-planner.js';
import { configFingerprint, packFingerprint } from '../orchestrator/recovery.js';
import { renderComparison } from '../report/comparison-table.js';
import { buildReportData } from '../report/report-data.js';
import { renderSweepReport } from '../report/terminal-report.js';
import { RunStore } from '../results/run-store.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { checkExpectedValues } from '../scoring/plan-check.js';
import { listScorers } from '../scoring/scorer-registry.js';
import { loadTaskPack, TaskPackError } from '../tasks/task-loader.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';
import { queryGpuIdentity, queryVramOnce } from '../telemetry/vram-probe.js';

/** Options parsed from the command line. */
export interface RunCommandOptions {
  readonly pack: string;
  /** Run exactly this model instead of resolving a candidate set. */
  readonly model?: string;
  /** Run config file with explicit candidates. */
  readonly config?: string;
  /** Attempt candidates predicted not to fit. */
  readonly force?: boolean;
  readonly db?: string;
  /** Run only the first N examples. */
  readonly limit?: number;
  readonly baseUrl?: string;
}

/** Applies --limit to a loaded pack. */
export function limitPack(pack: LoadedTaskPack, limit: number | undefined): LoadedTaskPack {
  if (limit === undefined) {
    return pack;
  }
  if (limit < 1) {
    throw new Error(`--limit ${String(limit)} leaves no examples to run; use a value of 1 or more`);
  }
  return { ...pack, examples: pack.examples.slice(0, limit) };
}

/**
 * Plans and executes a sweep, printing progress and the final tables.
 *
 * @param options - Parsed command options.
 * @returns The rendered report text (also printed), for tests.
 * @throws TaskPackError on an invalid pack; backend errors when Ollama
 *   is unreachable; a plan error when nothing is left to run.
 */
export async function runCommand(options: RunCommandOptions): Promise<string> {
  registerBuiltinScorers();
  const pack = limitPack(loadTaskPack(options.pack, listScorers()), options.limit);
  const authoringProblems = checkExpectedValues(pack);
  if (authoringProblems.length > 0) {
    throw new TaskPackError(options.pack, authoringProblems);
  }
  const adapter = new OllamaAdapter(options.baseUrl);
  const backendVersion = await adapter.version();

  let descriptors: readonly ModelDescriptor[];
  if (options.model !== undefined) {
    descriptors = [await adapter.ensureModelAvailable(options.model)];
  } else {
    const config = options.config === undefined ? DEFAULT_RUN_CONFIG : loadRunConfig(options.config);
    const resolved = await resolveCandidates(adapter, config);
    for (const excluded of resolved.excluded) {
      console.log(`  excluded ${excluded.name}: ${excluded.reason}`);
    }
    descriptors = resolved.candidates;
  }
  if (descriptors.length === 0) {
    throw new Error(
      'no candidates to run; pull a model (ollama pull gemma3:1b), pass --model, or list candidates in a --config file',
    );
  }

  const gpu = queryGpuIdentity();
  const freeVramMib = queryVramOnce()?.freeMib ?? null;
  const assessments = await assessCandidates(adapter, descriptors, pack.manifest.generation.context, freeVramMib);
  // An explicitly named model is always attempted: naming it is the override.
  const force = (options.force ?? false) || options.model !== undefined;
  const plan = buildRunPlan(assessments, {
    force,
    unitsPerCandidate: pack.examples.length * pack.manifest.generation.runs_per_example,
    maxTokens: pack.manifest.generation.max_tokens,
  });
  console.log(renderRunPlan(plan, pack.manifest.name));
  if (plan.included.length === 0) {
    throw new Error('every candidate was predicted not to fit; rerun with --force to attempt them anyway');
  }

  const store = RunStore.open(options.db ?? '.quantproof/results.db');
  try {
    const prepared = prepareSweepJournal(
      store, pack, options.pack, plan,
      {
        explicitModel: options.model ?? null,
        configPath: options.config ?? null,
        configFingerprint: configFingerprint(options.config ?? null),
        packFingerprint: packFingerprint(options.pack),
        limit: options.limit ?? null,
        force,
      },
      {
        backendVersion,
        gpu,
        vramUnavailableReason:
          gpu === null ? 'nvidia-smi is not available on this machine, so VRAM was not measured' : null,
      },
    );
    const outcome = await executeSweep(pack, prepared, {
      adapter,
      store,
      onProgress: (line) => {
        console.log(`  ${line}`);
      },
    });
    const data = buildReportData(
      outcome.run,
      store.listCandidates(outcome.run.id),
      store.listUnitResults(outcome.run.id),
    );
    const report = renderSweepReport(outcome) + renderComparison(data);
    console.log(report);
    return report;
  } finally {
    store.close();
  }
}

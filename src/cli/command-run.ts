/**
 * The run command: one task pack against one named model, ending in
 * the measured result table.
 */

import { OllamaAdapter } from '../backends/ollama-adapter.js';
import { executeSingleModelRun } from '../orchestrator/run-executor.js';
import { renderTerminalReport } from '../report/terminal-report.js';
import { RunStore } from '../results/run-store.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { listScorers } from '../scoring/scorer-registry.js';
import { loadTaskPack } from '../tasks/task-loader.js';

/** Options parsed from the command line. */
export interface RunCommandOptions {
  /** Task pack directory. */
  readonly pack: string;
  /** Backend model name, e.g. "gemma3:1b". */
  readonly model: string;
  /** Results database path; defaults to .quantproof/results.db. */
  readonly db?: string;
  /** Run only the first N examples (smoke tests, quick checks). */
  readonly limit?: number;
  /** Ollama base url override, mainly for tests. */
  readonly baseUrl?: string;
}

/**
 * Executes a single-model run and prints progress plus the final
 * table.
 *
 * @param options - Parsed command options.
 * @returns The rendered report text (also printed), so tests can
 *   assert on it.
 * @throws TaskPackError on an invalid pack; backend errors when Ollama
 *   is unreachable or the model cannot be made available.
 */
export async function runCommand(options: RunCommandOptions): Promise<string> {
  registerBuiltinScorers();
  const loaded = loadTaskPack(options.pack, listScorers());
  const pack =
    options.limit === undefined
      ? loaded
      : { ...loaded, examples: loaded.examples.slice(0, options.limit) };
  if (pack.examples.length === 0) {
    throw new Error(`--limit ${String(options.limit)} leaves no examples to run; use a value of 1 or more`);
  }

  const adapter = new OllamaAdapter(options.baseUrl);
  const store = RunStore.open(options.db ?? '.quantproof/results.db');
  try {
    console.log(
      `running ${pack.manifest.name} (${String(pack.examples.length)} examples x ` +
        `${String(pack.manifest.generation.runs_per_example)} reps) against ${options.model}`,
    );
    const outcome = await executeSingleModelRun(pack, options.pack, options.model, {
      adapter,
      store,
      onProgress: (line) => {
        console.log(`  ${line}`);
      },
    });
    const report = renderTerminalReport(outcome);
    console.log(report);
    return report;
  } finally {
    store.close();
  }
}

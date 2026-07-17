/**
 * The resume command: pick up the newest incomplete run from the
 * journal and execute only its unfinished, non-OOM units, reusing the
 * original plan and config exactly.
 */

import { OllamaAdapter } from '../backends/ollama-adapter.js';
import { buildResume, findResumableRun, verifyNoDrift } from '../orchestrator/recovery.js';
import { executeSweep } from '../orchestrator/run-executor.js';
import { renderComparison } from '../report/comparison-table.js';
import { buildReportData } from '../report/report-data.js';
import { renderSweepReport } from '../report/terminal-report.js';
import { RunStore } from '../results/run-store.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { checkExpectedValues } from '../scoring/plan-check.js';
import { listScorers } from '../scoring/scorer-registry.js';
import { loadTaskPack, TaskPackError } from '../tasks/task-loader.js';
import { limitPack } from './command-run.js';

/** Options parsed from the command line. */
export interface ResumeCommandOptions {
  readonly db?: string;
  readonly baseUrl?: string;
}

/**
 * Resumes the newest incomplete run.
 *
 * @param options - Parsed command options.
 * @returns The rendered report for the resumed candidates, or a
 *   message when there is nothing to resume (also printed).
 * @throws When the pack or config drifted since planning, with an
 *   explanation of why resuming would corrupt the results.
 */
export async function resumeCommand(options: ResumeCommandOptions): Promise<string> {
  registerBuiltinScorers();
  const store = RunStore.open(options.db ?? '.quantproof/results.db');
  try {
    const run = findResumableRun(store);
    if (run === null) {
      const message = 'nothing to resume: every journaled run is complete';
      console.log(message);
      return message;
    }
    verifyNoDrift(run);
    const pack = limitPack(
      loadTaskPack(run.packDir, listScorers()),
      run.plan.limit ?? undefined,
    );
    const authoringProblems = checkExpectedValues(pack);
    if (authoringProblems.length > 0) {
      throw new TaskPackError(run.packDir, authoringProblems);
    }
    const prepared = buildResume(store, run);
    console.log(
      `resuming run ${run.id} (${run.packName}): ${String(prepared.entries.length)} candidate${prepared.entries.length === 1 ? '' : 's'} with ` +
        `${String(prepared.entries.reduce((n, e) => n + e.units.length, 0))} pending units`,
    );
    const outcome = await executeSweep(pack, prepared, {
      adapter: new OllamaAdapter(options.baseUrl),
      store,
      onProgress: (line) => {
        console.log(`  ${line}`);
      },
    });
    const data = buildReportData(run, store.listCandidates(run.id), store.listUnitResults(run.id));
    const report = renderSweepReport(outcome) + renderComparison(data);
    console.log(report);
    return report;
  } finally {
    store.close();
  }
}

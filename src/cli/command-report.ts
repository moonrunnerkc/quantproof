/**
 * The report command: renders any stored run (latest by default) as
 * the terminal comparison, a markdown file, or a reproducibility
 * bundle. Outputs are always re-scored from raw outputs when the pack
 * still matches, so a report reflects today's scorers and says so when
 * that changed anything.
 */

import { writeFileSync } from 'node:fs';
import { renderComparison } from '../report/comparison-table.js';
import { renderMarkdownReport } from '../report/markdown-report.js';
import { buildReportData } from '../report/report-data.js';
import { rescoreUnits } from '../report/rescore.js';
import { buildBundle } from '../results/bundle.js';
import type { RunRecord } from '../results/record-types.js';
import { RunStore } from '../results/run-store.js';

/** Options parsed from the command line. */
export interface ReportCommandOptions {
  /** Run id to render; the newest run when omitted. */
  readonly runId?: string;
  readonly db?: string;
  /** Write the markdown report to a file. */
  readonly markdown?: boolean;
  /** Export the reproducibility bundle zip. */
  readonly bundle?: boolean;
  /** Output path; defaults derive from the run id. */
  readonly out?: string;
  /** Relative quality tolerance for the recommendation. */
  readonly tolerance?: number;
}

function pickRun(runs: readonly RunRecord[], runId: string | undefined): RunRecord {
  if (runs.length === 0) {
    throw new Error('no runs recorded yet; run quantproof run --pack <dir> first');
  }
  if (runId === undefined) {
    return runs[0] as RunRecord;
  }
  const match = runs.find((r) => r.id === runId || r.id.startsWith(runId));
  if (match === undefined) {
    const known = runs.slice(0, 10).map((r) => `  ${r.id} (${r.packName})`).join('\n');
    throw new Error(`run "${runId}" is not in the results database; newest runs:\n${known}`);
  }
  return match;
}

/**
 * Renders a stored run.
 *
 * @param options - Parsed command options.
 * @returns The rendered terminal comparison (also printed). --markdown
 *   and --bundle additionally write files and print their paths.
 * @throws When the database has no runs, the run id is unknown, or an
 *   output file cannot be written.
 */
export function reportCommand(options: ReportCommandOptions): string {
  const store = RunStore.open(options.db ?? '.quantproof/results.db');
  try {
    const run = pickRun(store.listRuns(), options.runId);
    const candidates = store.listCandidates(run.id);
    const rescore = rescoreUnits(run, store.listUnitResults(run.id));
    const data = buildReportData(run, candidates, rescore.units, {
      ...(options.tolerance === undefined ? {} : { qualityTolerance: options.tolerance }),
      notes: rescore.notes,
    });

    const shortId = run.id.slice(0, 8);
    if (options.markdown === true) {
      const path = options.out ?? `quantproof-report-${shortId}.md`;
      writeFileSync(path, renderMarkdownReport(data));
      console.log(`wrote ${path}`);
    }
    if (options.bundle === true) {
      const path =
        options.out !== undefined && options.markdown !== true
          ? options.out
          : `quantproof-bundle-${shortId}.zip`;
      writeFileSync(
        path,
        buildBundle({
          run,
          candidates,
          units: rescore.units,
          markdownReport: renderMarkdownReport(data),
          pack: rescore.pack,
        }),
      );
      console.log(`wrote ${path}`);
    }
    const comparison = renderComparison(data);
    if (options.markdown !== true && options.bundle !== true) {
      console.log(comparison);
    }
    return comparison;
  } finally {
    store.close();
  }
}

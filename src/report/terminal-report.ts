/**
 * Terminal table renderer: one table per candidate plus an environment
 * line, and a sweep renderer that stacks them. Pure string building so
 * it is testable and the CLI just prints it.
 */

import type { RunSummary } from './aggregate.js';
import type { CandidateRecord, RunRecord } from '../results/record-types.js';
import type { SweepOutcome } from '../orchestrator/run-executor.js';
import type { VramProbeResult } from '../telemetry/vram-probe.js';

/** Everything the renderer needs for one candidate's table. */
export interface ReportInput {
  readonly run: RunRecord;
  readonly candidate: CandidateRecord;
  readonly status: 'completed' | 'failed' | 'oom';
  readonly statusReason: string | null;
  readonly offloadSuspectReason: string | null;
  readonly summary: RunSummary;
  readonly vram: VramProbeResult;
}

const fmt = (value: number | null, digits: number, unit: string): string =>
  value === null ? 'n/a' : `${value.toFixed(digits)}${unit}`;

function renderRow(label: string, value: string): string {
  return `  ${label.padEnd(22)} ${value}`;
}

function qualityLine(summary: RunSummary): string {
  if (summary.meanScore === null || summary.scoreSpread === null) {
    return 'no completed generations';
  }
  const spread =
    summary.scoreSpread.max - summary.scoreSpread.min < 1e-9
      ? 'no spread across repetitions'
      : `rep spread ${summary.scoreSpread.min.toFixed(3)} to ${summary.scoreSpread.max.toFixed(3)}`;
  return `${summary.meanScore.toFixed(3)} (${spread})`;
}

function vramLine(input: ReportInput): string {
  if (!input.vram.available) {
    return `NOT MEASURED: ${input.vram.reason}`;
  }
  const predicted = input.candidate.predictedPeakMib;
  const measured = input.vram.peakMib;
  const versus =
    predicted === null
      ? 'prediction unavailable'
      : `predicted ${predicted.toFixed(0)} MiB, delta ${(((measured - predicted) / predicted) * 100).toFixed(1)}%`;
  return `${String(measured)} MiB peak measured (${versus})`;
}

function determinismLine(summary: RunSummary): string {
  if (summary.outputsDeterministic === null) {
    return 'not checked (single repetition)';
  }
  return summary.outputsDeterministic
    ? 'outputs identical across repetitions'
    : 'NONDETERMINISTIC: outputs differ across repetitions for identical requests';
}

/**
 * Renders the result table for one candidate. Unmeasured VRAM, OOM,
 * nondeterminism, and suspected partial offload all render loudly
 * instead of disappearing into "n/a".
 *
 * @param input - Run, candidate, status, aggregated summary, and VRAM.
 * @returns A multi-line string ready for stdout.
 */
export function renderTerminalReport(input: ReportInput): string {
  const { run, candidate, summary } = input;
  const lines: string[] = [];
  lines.push('');
  lines.push(`${run.packName} x ${candidate.modelName}`);
  lines.push('-'.repeat(60));
  if (input.status === 'oom') {
    lines.push(renderRow('result', `OOM at context ${String(run.generation.context)} (a result, not an error)`));
    lines.push(renderRow('detail', input.statusReason ?? 'no detail recorded'));
  } else if (input.status === 'failed') {
    lines.push(renderRow('result', `FAILED: ${input.statusReason ?? 'no reason recorded'}`));
  }
  lines.push(renderRow('quality (mean score)', qualityLine(summary)));
  lines.push(renderRow('pass rate', fmt(summary.passRate === null ? null : summary.passRate * 100, 1, '%')));
  lines.push(renderRow('ttft median', fmt(summary.ttftMedianMs, 0, ' ms')));
  lines.push(renderRow('tokens/sec median', fmt(summary.tokensPerSecondMedian, 1, '')));
  lines.push(renderRow('peak memory', vramLine(input)));
  lines.push(renderRow('fit prediction', `${candidate.fitVerdict}${candidate.predictedPeakMib === null ? '' : `, predicted peak ${candidate.predictedPeakMib.toFixed(0)} MiB`}`));
  if (input.offloadSuspectReason !== null) {
    lines.push(renderRow('offload', `SUSPECTED CPU/GPU SPLIT: ${input.offloadSuspectReason}`));
  }
  if (summary.truncatedEmptyCount > 0) {
    lines.push(
      renderRow(
        'truncation',
        `TRUNCATED BEFORE CONTENT: ${String(summary.truncatedEmptyCount)} of ${String(summary.completed)} units stopped at max_tokens ${String(run.generation.max_tokens)} ` +
          'with no visible output; raise generation.max_tokens in task.yaml',
      ),
    );
  }
  lines.push(renderRow('determinism', determinismLine(summary)));
  lines.push(
    renderRow(
      'units',
      `${String(summary.completed)} completed, ${String(summary.failed)} failed, ` +
        `${String(summary.pending)} pending, ${String(summary.skipped)} skipped`,
    ),
  );
  lines.push('-'.repeat(60));
  const gpu = run.gpuName === null ? 'gpu unknown' : `${run.gpuName} (driver ${run.driverVersion ?? 'unknown'})`;
  lines.push(
    `  env: ${run.backendVersion} | ${candidate.modelName}@${candidate.digest.slice(0, 12)}` +
      ` | ${candidate.quantization ?? 'quant unknown'} | ${gpu}`,
  );
  lines.push(
    `  repro: quantproof run --pack ${run.packDir}` +
      ` (seed ${String(run.generation.seed)}, temp ${String(run.generation.temperature)},` +
      ` ctx ${String(run.generation.context)}, ${String(run.generation.runs_per_example)} reps)`,
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Renders a whole sweep: one table per candidate in execution order.
 *
 * @param outcome - The finished sweep.
 * @returns Concatenated candidate tables.
 */
export function renderSweepReport(outcome: SweepOutcome): string {
  return outcome.candidates
    .map((candidate) =>
      renderTerminalReport({
        run: outcome.run,
        candidate: candidate.candidate,
        status: candidate.status,
        statusReason: candidate.statusReason,
        offloadSuspectReason: candidate.offloadSuspectReason,
        summary: candidate.summary,
        vram: candidate.vram,
      }),
    )
    .join('');
}

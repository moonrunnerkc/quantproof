/**
 * Terminal table renderer: one candidate's measured results plus an
 * environment line. Pure string building so it is testable and the CLI
 * just prints it.
 */

import type { RunSummary } from './aggregate.js';
import type { CandidateRecord, RunRecord } from '../results/record-types.js';
import type { VramProbeResult } from '../telemetry/vram-probe.js';

/** Everything the renderer needs for one candidate's table. */
export interface ReportInput {
  readonly run: RunRecord;
  readonly candidate: CandidateRecord;
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

function vramLine(vram: VramProbeResult): string {
  if (!vram.available) {
    return `NOT MEASURED: ${vram.reason}`;
  }
  return `${String(vram.peakMib)} MiB peak (${String(vram.samples.length)} samples)`;
}

function determinismLine(summary: RunSummary): string {
  if (summary.outputsDeterministic === null) {
    return 'not checked (single repetition)';
  }
  return summary.outputsDeterministic
    ? 'outputs identical across repetitions'
    : 'NONDETERMINISTIC: outputs differ across repetitions despite fixed seed';
}

/**
 * Renders the result table for one candidate.
 *
 * @param input - Run, candidate, aggregated summary, and VRAM outcome.
 * @returns A multi-line string ready for stdout. Unmeasured VRAM and
 *   nondeterminism render loudly instead of disappearing into "n/a".
 */
export function renderTerminalReport(input: ReportInput): string {
  const { run, candidate, summary, vram } = input;
  const lines: string[] = [];
  lines.push('');
  lines.push(`${run.packName} x ${candidate.modelName}`);
  lines.push('-'.repeat(60));
  lines.push(renderRow('quality (mean score)', qualityLine(summary)));
  lines.push(renderRow('pass rate', fmt(summary.passRate === null ? null : summary.passRate * 100, 1, '%')));
  lines.push(renderRow('ttft median', fmt(summary.ttftMedianMs, 0, ' ms')));
  lines.push(renderRow('tokens/sec median', fmt(summary.tokensPerSecondMedian, 1, '')));
  lines.push(renderRow('peak vram', vramLine(vram)));
  lines.push(renderRow('determinism', determinismLine(summary)));
  lines.push(
    renderRow(
      'units',
      `${String(summary.completed)} completed, ${String(summary.failed)} failed, ${String(summary.pending)} pending`,
    ),
  );
  lines.push('-'.repeat(60));
  const gpu = vram.available ? `${vram.gpu.name} (driver ${vram.gpu.driverVersion})` : 'gpu unknown';
  lines.push(
    `  env: ${run.backendVersion} | ${candidate.modelName}@${candidate.digest.slice(0, 12)}` +
      ` | ${candidate.quantization ?? 'quant unknown'} | ${gpu}`,
  );
  lines.push(
    `  repro: quantproof run --pack ${run.packDir} --model ${candidate.modelName}` +
      ` (seed ${String(run.generation.seed)}, temp ${String(run.generation.temperature)},` +
      ` ctx ${String(run.generation.context)}, ${String(run.generation.runs_per_example)} reps)`,
  );
  lines.push('');
  return lines.join('\n');
}
